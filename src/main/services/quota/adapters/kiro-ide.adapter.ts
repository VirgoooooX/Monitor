// Kiro IDE (AWS Q Developer) provider adapter.
//
// Kiro is the AWS-built agentic IDE; subscriptions ship as Pro
// ($20/mo, 1k credits), Pro+ ($40/mo, 2k credits), and Power
// ($200/mo, 10k credits) on top of a 50-credit free tier. The IDE
// itself authenticates against `prod.<region>.auth.desktop.kiro.dev`
// (Kiro Desktop Auth) or the AWS SSO OIDC endpoint for IAM Identity
// Center logins, and persists the resulting access / refresh tokens
// at `~/.aws/sso/cache/kiro-auth-token.json` (camelCase fields:
// `accessToken`, `refreshToken`, `profileArn`, `expiresAt`,
// `authMethod`, `provider`).
//
// The IDE then queries usage via the AWS CodeWhisperer Smithy client
// (`AmazonCodeWhispererService.GetUsageLimits`) at:
//
//   GET https://q.<region>.amazonaws.com/getUsageLimits
//       ?isEmailRequired=true
//       &origin=AI_EDITOR
//       &profileArn=<urlencoded ARN>
//       &resourceType=AGENTIC_REQUEST
//
//   Authorization: Bearer <accessToken>
//
// Region is encoded in the fourth ARN segment
// (`arn:aws:codewhisperer:<region>:<account>:profile/<id>`).
//
// Response shape (relevant fields, observed live on a Pro+ account):
//
//   {
//     "subscriptionInfo": { "subscriptionTitle": "KIRO PRO+", ... },
//     "overageConfiguration": { "overageStatus": "ENABLED" },
//     "usageBreakdownList": [{
//       "currentUsage": 37,
//       "currentUsageWithPrecision": 37.43,
//       "usageLimit": 2000,
//       "usageLimitWithPrecision": 2000.0,
//       "overageCap": 10000,
//       "nextDateReset": 1.780272E9,         // epoch seconds
//       "currency": "USD",
//       "displayName": "Credit",
//       "resourceType": "CREDIT"
//     }],
//     "userInfo": { "email": "...", "userId": "..." }
//   }
//
// We surface the usage as a single `quota` window so it shows up in
// the strip with the same shape as Codex's 5-hour bucket — the
// progress bar fills with the remaining-credits percentage and the
// reset timestamp drives the relative-time meta column. The plan
// title (`KIRO PRO+`) lands in `rawPlanLabel` so the expanded card
// displays it next to the provider chip.

import {
  expiresAtHasPassed,
  jwtExpiresAtHasPassed,
  okSnapshot,
  ProviderAdapterError,
  requestJson,
  type RequestJson,
  unavailableSnapshot,
  asRecord,
  asFiniteNumber,
} from './common';
import type { ProviderAdapter, ProviderAdapterRefreshInput } from './types';
import type {
  KiroTokenRefreshSettings,
  ProviderAuthSecretPayload,
  QuotaWindow,
} from '../../../types';
import {
  refreshKiroToken,
  type KiroAuthMethod,
} from './kiro-token-refresher';
import {
  readKiroAuthFile,
  writeKiroAuthFile,
} from './kiro-auth-file-writer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fallback Q Developer region when the secret payload does not carry
 * a profile ARN. `us-east-1` is the canonical default — the IDE
 * itself routes there when no IAM Identity Center region is set.
 */
const DEFAULT_REGION = 'us-east-1';

/**
 * Whitelist of region codes we accept after parsing a profile ARN.
 * Mirrors the AWS service availability list used by Kiro's IDE
 * client; anything else falls back to {@link DEFAULT_REGION} so a
 * malformed ARN cannot drive the adapter to an attacker-controlled
 * host.
 */
const SUPPORTED_REGIONS: ReadonlySet<string> = new Set([
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-7',
  'ap-south-1',
  'ap-south-2',
  'ap-east-1',
  'ca-central-1',
  'ca-west-1',
  'sa-east-1',
  'me-south-1',
  'me-central-1',
  'il-central-1',
  'mx-central-1',
  'af-south-1',
]);

const REGION_FORMAT = /^[a-z]+-[a-z]+-\d+$/;
const ARN_FORMAT = /^arn:aws:codewhisperer:[a-z0-9-]+:[0-9]+:profile\/[A-Z0-9]+$/i;

/**
 * Auto-refresh trigger threshold. When `expiresAt - now < this`, the
 * adapter exchanges the stored refresh token for a fresh access
 * token before calling `getUsageLimits`. Five minutes is wide
 * enough to absorb the worst-case usage tick latency while staying
 * narrow enough that we rarely race the IDE (which uses a similar
 * window). Configurable per-call via {@link KiroIdeAdapterDeps.refreshThresholdMs}.
 */
const DEFAULT_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

const DEFAULT_REFRESH_SETTINGS: KiroTokenRefreshSettings = {
  enabled: true,
  writeBackAuthFile: true,
};

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface KiroIdeAdapterDeps {
  readonly requestJson?: RequestJson;
  /**
   * Persist a rotated secret payload back to the encrypted `secrets`
   * row. Threaded in by `quota.service.ts`; tests inject a stub. When
   * omitted, the adapter still works but skips both the secret write
   * and the source-file write — it simply uses the new access token
   * for the current call and lets the next refresh cycle re-acquire
   * one.
   */
  readonly persistSecret?: (payload: ProviderAuthSecretPayload) => void;
  /**
   * Read the current `KiroTokenRefreshSettings`. Defaults to
   * `{ enabled: true, writeBackAuthFile: true }` when omitted, so
   * tests that don't care about gating get the full feature path.
   */
  readonly getRefreshSettings?: () => KiroTokenRefreshSettings;
  /** Override the auto-refresh trigger window for tests. */
  readonly refreshThresholdMs?: number;
}

export function createKiroIdeAdapter(
  deps: KiroIdeAdapterDeps = {},
): ProviderAdapter {
  const doRequest = deps.requestJson ?? requestJson;
  const refreshThresholdMs =
    deps.refreshThresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS;

  // Per-account in-flight refresh dedup. Two concurrent quota ticks
  // for the same Kiro account would otherwise burn two refresh
  // tokens — the second one would land on a now-rotated chain and
  // trip a spurious `auth_expired`. Same pattern as the
  // serviceToken cache in `xiaomi.adapter.ts`.
  const inFlight = new Map<string, Promise<RefreshOutcome>>();

  return {
    provider: 'kiro-ide',
    capability: 'official',
    async refresh(input) {
      // Per-call `persistSecret` (from `quota.service.ts`) wins
      // over the factory-level fallback so production code (which
      // threads it through the input) and tests (which can pin one
      // on the factory) both work.
      const persistSecret = input.persistSecret ?? deps.persistSecret;
      const ctx: AdapterContext = {
        doRequest,
        refreshThresholdMs,
        getRefreshSettings:
          deps.getRefreshSettings ?? (() => DEFAULT_REFRESH_SETTINGS),
        inFlight,
        ...(persistSecret !== undefined ? { persistSecret } : {}),
      };
      return runRefresh(input, ctx);
    },
  };
}

export const kiroIdeAdapter: ProviderAdapter = createKiroIdeAdapter();

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------

interface AdapterContext {
  readonly doRequest: RequestJson;
  readonly refreshThresholdMs: number;
  readonly getRefreshSettings: () => KiroTokenRefreshSettings;
  readonly persistSecret?: (payload: ProviderAuthSecretPayload) => void;
  readonly inFlight: Map<string, Promise<RefreshOutcome>>;
}

interface RefreshOutcome {
  readonly accessToken: string;
  readonly payload: ProviderAuthSecretPayload;
}

async function runRefresh(
  input: ProviderAdapterRefreshInput,
  ctx: AdapterContext,
): ReturnType<ProviderAdapter['refresh']> {
  const { account, getSecret, now, signal } = input;
  const secret = getSecret();
  if (secret === null) {
    return unavailableSnapshot(
      account,
      now,
      'auth_missing',
      'Kiro IDE auth token is missing',
    );
  }

  let activeAccessToken =
    typeof secret.accessToken === 'string' ? secret.accessToken.trim() : '';
  let activePayload: ProviderAuthSecretPayload = secret;

  if (activeAccessToken.length === 0) {
    return unavailableSnapshot(
      account,
      now,
      'auth_missing',
      'Kiro IDE access token is missing',
    );
  }

  // Auto-refresh path: only triggered when the user has the feature
  // enabled AND the access token is within the threshold of expiring
  // AND we have a refresh token to spend. Any of these missing →
  // fall through to the legacy expiry guard below.
  const settings = ctx.getRefreshSettings();
  if (
    settings.enabled &&
    shouldAttemptRefresh(secret, now, ctx.refreshThresholdMs) &&
    typeof secret.refreshToken === 'string' &&
    secret.refreshToken.trim().length > 0
  ) {
    try {
      const outcome = await acquireRefreshedToken(
        account.id,
        secret,
        now,
        signal,
        settings,
        ctx,
      );
      activeAccessToken = outcome.accessToken;
      activePayload = outcome.payload;
    } catch (err) {
      // RT chain is dead → bubble up; the caller marks the row
      // `auth_expired` and the renderer surfaces the re-import prompt.
      if (err instanceof ProviderAdapterError && err.code === 'auth_expired') {
        throw err;
      }
      // Transient failure (network, 5xx, file write). If the existing
      // access token is still usable for the current tick, soldier on
      // — the next tick will retry the refresh. Otherwise we're out of
      // options, propagate.
      if (
        expiresAtHasPassed(activePayload.expiresAt, now) ||
        jwtExpiresAtHasPassed(activeAccessToken, now)
      ) {
        if (err instanceof ProviderAdapterError) throw err;
        throw new ProviderAdapterError(
          'network_error',
          'Kiro IDE token refresh failed',
        );
      }
    }
  }

  // Legacy expiry guard. After auto-refresh ran (or was skipped),
  // verify the access token we're about to use still has time on
  // the clock. This is the same belt-and-braces check the adapter
  // shipped with originally.
  if (
    expiresAtHasPassed(activePayload.expiresAt, now) ||
    jwtExpiresAtHasPassed(activeAccessToken, now)
  ) {
    throw new ProviderAdapterError(
      'auth_expired',
      'Kiro IDE auth token expired',
    );
  }

  const profileArn =
    typeof activePayload.kiroProfileArn === 'string'
      ? activePayload.kiroProfileArn.trim()
      : '';
  const region = resolveRegion(profileArn);

  const url = buildUsageLimitsUrl(region, profileArn);

  type GetUsageLimitsResponse = {
    readonly subscriptionInfo?: {
      readonly subscriptionTitle?: string;
    };
    readonly overageConfiguration?: {
      readonly overageStatus?: string;
    };
    readonly usageBreakdownList?: ReadonlyArray<unknown>;
  };

  let result: GetUsageLimitsResponse;
  try {
    result = await ctx.doRequest<GetUsageLimitsResponse>({
      url,
      method: 'GET',
      ...(signal !== undefined ? { signal } : {}),
      headers: {
        Authorization: `Bearer ${activeAccessToken}`,
        // The IDE itself sends `KiroIDE <version> <machineId>`;
        // the version / machine id are advisory — AWS only
        // enforces the bearer token. We send a stable, harmless
        // marker so the request is identifiable in audit logs.
        'User-Agent': 'KiroIDE 0.0.0 monitor',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    if (err instanceof ProviderAdapterError) {
      // 401/403/429 / network errors map to typed snapshots so the
      // UI surfaces the right copy without inventing new codes.
      if (
        err.code === 'upstream_unauthorized' ||
        err.code === 'auth_expired'
      ) {
        throw new ProviderAdapterError(
          'auth_expired',
          'Kiro IDE auth rejected by AWS',
        );
      }
      throw err;
    }
    throw new ProviderAdapterError(
      'network_error',
      'Kiro IDE quota request failed',
    );
  }

  const breakdown = parseFirstBreakdown(result);
  if (breakdown === null) {
    return unavailableSnapshot(
      account,
      now,
      'upstream_changed',
      'Kiro IDE response missing usageBreakdownList',
    );
  }

  const window = breakdownToWindow(breakdown, now);
  if (window === null) {
    return unavailableSnapshot(
      account,
      now,
      'upstream_changed',
      'Kiro IDE response missing usage / limit numbers',
    );
  }

  const planLabel = readPlanLabel(result);
  return okSnapshot(account, now, [window], {
    kind: 'quota',
    rawPlanLabel: planLabel,
  });
}

// ---------------------------------------------------------------------------
// Helpers (refresh + IDE coordination)
// ---------------------------------------------------------------------------

/**
 * Decide whether the access token is close enough to expiry to
 * warrant a refresh round-trip. We respect both the explicit
 * `expiresAt` field (parsed from the file's ISO string) and the JWT
 * `exp` claim — Kiro's access tokens are JWTs, and the two values
 * have been observed to drift by a few seconds.
 */
function shouldAttemptRefresh(
  secret: ProviderAuthSecretPayload,
  now: number,
  thresholdMs: number,
): boolean {
  if (typeof secret.expiresAt === 'number' && Number.isFinite(secret.expiresAt)) {
    if (secret.expiresAt - now < thresholdMs) return true;
  } else {
    // Missing `expiresAt` is treated as "refresh now" — happens with
    // legacy rows imported before the parser learned the field. The
    // first refresh repopulates it.
    return true;
  }
  if (typeof secret.accessToken === 'string') {
    if (
      jwtExpiresAtHasPassed(
        secret.accessToken,
        now + thresholdMs - 1, // shift now forward by threshold to test imminent expiry
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Coalesce concurrent refreshes for one account into a single
 * refresh-token exchange. The map entry is cleared in `finally`
 * so a one-off failure doesn't poison subsequent ticks.
 */
async function acquireRefreshedToken(
  accountId: string,
  secret: ProviderAuthSecretPayload,
  now: number,
  signal: AbortSignal | undefined,
  settings: KiroTokenRefreshSettings,
  ctx: AdapterContext,
): Promise<RefreshOutcome> {
  const existing = ctx.inFlight.get(accountId);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<RefreshOutcome> => {
    return refreshAndPersist(secret, now, signal, settings, ctx);
  })();

  ctx.inFlight.set(accountId, promise);
  try {
    return await promise;
  } finally {
    ctx.inFlight.delete(accountId);
  }
}

async function refreshAndPersist(
  secret: ProviderAuthSecretPayload,
  now: number,
  signal: AbortSignal | undefined,
  settings: KiroTokenRefreshSettings,
  ctx: AdapterContext,
): Promise<RefreshOutcome> {
  // Pre-flight: if the user keeps the IDE open in parallel, the IDE
  // may have just refreshed the file for us. Re-read it before
  // burning our own RT.
  const filePath =
    typeof secret.kiroSourceFilePath === 'string' &&
    secret.kiroSourceFilePath.length > 0
      ? secret.kiroSourceFilePath
      : null;

  if (filePath !== null && settings.writeBackAuthFile) {
    try {
      const file = await readKiroAuthFile(filePath);
      if (
        file !== null &&
        file.accessToken !== null &&
        file.refreshToken !== null &&
        file.expiresAt !== null &&
        file.expiresAt - now > ctx.refreshThresholdMs
      ) {
        // IDE beat us to it — adopt the file's tokens verbatim.
        const adoptedPayload: ProviderAuthSecretPayload = {
          ...secret,
          accessToken: file.accessToken,
          refreshToken: file.refreshToken,
          expiresAt: file.expiresAt,
        };
        ctx.persistSecret?.(adoptedPayload);
        return {
          accessToken: file.accessToken,
          payload: adoptedPayload,
        };
      }
    } catch {
      // Reading / parsing the file is best-effort — if it fails we
      // fall through to the explicit refresh below.
    }
  }

  const profileArn =
    typeof secret.kiroProfileArn === 'string'
      ? secret.kiroProfileArn.trim()
      : '';
  const region = resolveRegion(profileArn);
  const authMethod = (typeof secret.kiroAuthMethod === 'string'
    ? secret.kiroAuthMethod.trim().toLowerCase()
    : null) as KiroAuthMethod | null;

  const refreshed = await refreshKiroToken(
    {
      refreshToken: (secret.refreshToken as string).trim(),
      authMethod,
      region,
    },
    {
      requestJson: ctx.doRequest,
      now: () => now,
      ...(signal !== undefined ? { signal } : {}),
    },
  );

  const nextProfileArn =
    refreshed.profileArn !== null ? refreshed.profileArn : profileArn;
  const nextPayload: ProviderAuthSecretPayload = {
    ...secret,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
    ...(nextProfileArn.length > 0 ? { kiroProfileArn: nextProfileArn } : {}),
  };

  // 1. Persist to encrypted secrets first — that store is our
  //    source of truth for the next quota tick. If the file write
  //    fails we still keep the new tokens.
  ctx.persistSecret?.(nextPayload);

  // 2. Best-effort write back to the source file so the IDE keeps
  //    using the same chain. Failures here never bubble: the secret
  //    row is already updated and the IDE will re-acquire on its
  //    own next launch.
  if (filePath !== null && settings.writeBackAuthFile) {
    try {
      await writeKiroAuthFile(filePath, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        profileArn: refreshed.profileArn,
      });
    } catch {
      // Swallowed — see comment above.
    }
  }

  return {
    accessToken: refreshed.accessToken,
    payload: nextPayload,
  };
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Pull the region segment out of an AWS CodeWhisperer profile ARN.
 * Falls back to {@link DEFAULT_REGION} when the ARN is missing,
 * malformed, or names an unsupported region — the latter guards
 * against a tampered auth file driving a request to an unexpected
 * host.
 */
export function resolveRegion(profileArn: string): string {
  if (!ARN_FORMAT.test(profileArn)) return DEFAULT_REGION;
  const region = profileArn.split(':')[3];
  if (region === undefined || !REGION_FORMAT.test(region)) return DEFAULT_REGION;
  return SUPPORTED_REGIONS.has(region) ? region : DEFAULT_REGION;
}

/**
 * Build the canonical `getUsageLimits` URL. The query parameter
 * order matches what the IDE itself sends so the request is
 * indistinguishable in AWS access logs:
 *   isEmailRequired → origin → profileArn → resourceType.
 */
export function buildUsageLimitsUrl(
  region: string,
  profileArn: string,
): string {
  const base = `https://q.${region}.amazonaws.com/getUsageLimits`;
  const params = new URLSearchParams();
  params.set('isEmailRequired', 'true');
  params.set('origin', 'AI_EDITOR');
  if (profileArn.length > 0) params.set('profileArn', profileArn);
  params.set('resourceType', 'AGENTIC_REQUEST');
  return `${base}?${params.toString()}`;
}

/**
 * Extract the first usage row from a `GetUsageLimits` response. The
 * IDE always emits exactly one entry today (`resourceType: CREDIT`,
 * `unit: INVOCATIONS`); we treat the list defensively so a future
 * multi-row response doesn't crash the adapter.
 */
export function parseFirstBreakdown(
  response: unknown,
): Record<string, unknown> | null {
  const root = asRecord(response);
  if (root === null) return null;
  const list = root['usageBreakdownList'];
  if (!Array.isArray(list) || list.length === 0) return null;
  return asRecord(list[0]);
}

/**
 * Translate one `usageBreakdownList` entry into a `QuotaWindow`.
 * Prefers the `*WithPrecision` fields when available so the bar
 * reflects fractional credit consumption (the IDE displays e.g.
 * "24.11 used / 2,000 covered in plan").
 *
 * `percentLeft` is computed as `clamp(0, 100, 100 * (limit - used) / limit)`.
 * `resetAt` is derived from `nextDateReset` (epoch seconds, sometimes
 * scientific notation).
 * `windowSeconds` is left null because the reset cycle is monthly
 * and aperiodic from the adapter's perspective.
 */
export function breakdownToWindow(
  breakdown: Record<string, unknown>,
  now: number,
): QuotaWindow | null {
  const used =
    asFiniteNumber(breakdown['currentUsageWithPrecision']) ??
    asFiniteNumber(breakdown['currentUsage']);
  const limit =
    asFiniteNumber(breakdown['usageLimitWithPrecision']) ??
    asFiniteNumber(breakdown['usageLimit']);
  if (used === null || limit === null || limit <= 0) return null;

  const remaining = Math.max(0, limit - used);
  const percentLeft =
    Math.round(Math.max(0, Math.min(100, (remaining / limit) * 100)) * 100) /
    100;

  const resetAt = parseResetAt(breakdown['nextDateReset'], now);

  return {
    name: 'kiro-credits',
    percentLeft,
    resetAt,
    windowSeconds: null,
  };
}

/**
 * `nextDateReset` is epoch seconds; the value sometimes arrives as
 * `1.780272E9` (scientific notation for 1_780_272_000). Both numeric
 * and string forms are accepted defensively.
 */
function parseResetAt(value: unknown, now: number): number | null {
  const seconds = asFiniteNumber(value);
  if (seconds === null || seconds <= 0) return null;
  // Anything below 1e11 is seconds; otherwise treat as ms.
  const ms = seconds < 1e11 ? Math.round(seconds * 1000) : Math.round(seconds);
  // Guard against pathological values that would render as far-past
  // timestamps in the UI.
  if (ms <= now - 365 * 86_400_000) return null;
  return ms;
}

/**
 * Pull the plan label (`KIRO PRO+`, `KIRO POWER`, …) out of
 * `subscriptionInfo.subscriptionTitle`. The renderer surfaces this
 * value verbatim in the expanded quota card.
 */
export function readPlanLabel(response: unknown): string | null {
  const root = asRecord(response);
  if (root === null) return null;
  const subscription = asRecord(root['subscriptionInfo']);
  if (subscription === null) return null;
  const title = subscription['subscriptionTitle'];
  if (typeof title !== 'string' || title.trim().length === 0) return null;
  return title.trim();
}
