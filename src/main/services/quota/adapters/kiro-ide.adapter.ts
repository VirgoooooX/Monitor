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
import type { ProviderAdapter } from './types';
import type { QuotaWindow } from '../../../types';

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

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface KiroIdeAdapterDeps {
  readonly requestJson?: RequestJson;
}

export function createKiroIdeAdapter(
  deps: KiroIdeAdapterDeps = {},
): ProviderAdapter {
  const doRequest = deps.requestJson ?? requestJson;

  return {
    provider: 'kiro-ide',
    capability: 'official',
    async refresh({ account, getSecret, now, signal }) {
      const secret = getSecret();
      if (secret === null) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'Kiro IDE auth token is missing',
        );
      }

      const accessToken =
        typeof secret.accessToken === 'string' ? secret.accessToken.trim() : '';
      if (accessToken.length === 0) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'Kiro IDE access token is missing',
        );
      }

      // Token expiry is recorded as ISO-8601 in the source file, which
      // the parser translates into epoch ms. Either signal forces
      // re-import (the adapter cannot itself drive the OAuth refresh
      // round-trip without persisting back to the auth file).
      if (
        expiresAtHasPassed(secret.expiresAt, now) ||
        jwtExpiresAtHasPassed(accessToken, now)
      ) {
        throw new ProviderAdapterError(
          'auth_expired',
          'Kiro IDE auth token expired',
        );
      }

      const profileArn =
        typeof secret.kiroProfileArn === 'string'
          ? secret.kiroProfileArn.trim()
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
        result = await doRequest<GetUsageLimitsResponse>({
          url,
          method: 'GET',
          ...(signal !== undefined ? { signal } : {}),
          headers: {
            Authorization: `Bearer ${accessToken}`,
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
    },
  };
}

export const kiroIdeAdapter: ProviderAdapter = createKiroIdeAdapter();

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
