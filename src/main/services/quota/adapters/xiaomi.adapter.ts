// Xiaomi MiMo provider adapter — official `/api/v1/balance` endpoint.
//
// Auth model (verified against platform.xiaomimimo.com production
// gateway, May 2026):
//
//   1. The user copies two cookies from `account.xiaomi.com` once:
//        - passToken : long-lived (months); rotates on password
//                      change or "log out everywhere"
//        - userId    : numeric account id
//      Both are stored encrypted in `ProviderAuthSecretPayload`.
//
//   2. On each refresh the adapter exchanges the passToken for a
//      short-lived `serviceToken` cookie scoped to
//      `platform.xiaomimimo.com`:
//        a. GET https://account.xiaomi.com/pass/serviceLogin
//             ?sid=api-platform&_json=true
//             Cookie: passToken=...; userId=...
//           -> JSON body (prefixed with `&&&START&&&`) containing
//              `nonce`, `ssecurity`, `location`.
//        b. clientSign = base64(SHA1(`nonce=<nonce>&<ssecurity>`))
//        c. GET <location>&clientSign=<urlencoded clientSign>
//           -> 200 with Set-Cookie carrying
//              `api-platform_serviceToken="..."`.
//
//   3. The serviceToken is cached in memory (per provider_auth row id)
//      until either (a) the next refresh sees a 401 from
//      `/api/v1/balance` or (b) the process restarts. We do NOT
//      persist the serviceToken — it is short-lived and treated as a
//      derived secret.
//
//   4. GET https://platform.xiaomimimo.com/api/v1/usage/detail
//        ?year=YYYY&month=M
//        Cookie: api-platform_serviceToken=...; userId=...
//      Response (dense array format, verified June 2026):
//        {
//          "code": 0,
//          "data": {
//            "tokenUsage": [
//              ["MM-DD", promptTokens, completionTokens, totalTokens, cumPromptTokens, cumCompletionTokens],
//              ...
//            ],
//            "requests": [["MM-DD", count], ...]
//          }
//        }
//      tokenUsage columns: date (MM-DD), total prompt, total completion,
//      total tokens, cumulative prompt, cumulative completion.
//      Response:
//        {
//          "code": 0,
//          "message": "",
//          "data": {
//            "balance":               "<decimal>",
//            "cashBalance":           "<decimal>",
//            "giftBalance":           "<decimal>",
//            "frozenBalance":         "<decimal>",
//            "currency":              "CNY" | "USD",
//            "overdraftLimit":        "<decimal>",
//            "remainingOverdraftLimit": "<decimal>"
//          }
//        }
//
// Privacy:
//   - passToken / serviceToken / userId are NEVER written to logs,
//     error messages, or the QuotaSnapshot. The window labels expose
//     only the currency and the public balance figures (mirroring
//     the DeepSeek adapter contract — see deepseek.adapter.ts).
//
//   - On 401 the cached serviceToken is invalidated and the next
//     refresh re-runs the full exchange. If the passToken itself is
//     no longer accepted, the adapter surfaces `auth_expired` and
//     the user must re-paste fresh cookies.

import * as crypto from 'node:crypto';

import {
  asRecord,
  okSnapshot,
  ProviderAdapterError,
  requestRaw,
  type RequestRaw,
  unavailableSnapshot,
} from './common';
import type { ProviderAdapter } from './types';
import type { DailyUsagePoint } from '../../../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_LOGIN_URL =
  'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&_json=true';
const BALANCE_URL =
  'https://platform.xiaomimimo.com/api/v1/balance';
const USAGE_DETAIL_URL =
  'https://platform.xiaomimimo.com/api/v1/usage/detail';

/** The platform gateway uses this prefixed cookie name; older
 *  documentation might refer to a plain `serviceToken`. */
const SERVICE_TOKEN_COOKIE = 'api-platform_serviceToken';

/** Xiaomi's `_json=true` responses are wrapped with this anti-XSSI prefix. */
const JSON_PREFIX = '&&&START&&&';

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface XiaomiAdapterDeps {
  readonly requestRaw?: RequestRaw;
  /**
   * Optional injection point for tests; defaults to a fresh in-memory
   * cache keyed by `provider_auth.id`. Production keeps a single
   * cache across the adapter lifetime.
   */
  readonly serviceTokenCache?: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServiceLoginResponse {
  readonly code: unknown;
  readonly nonce?: unknown;
  readonly ssecurity?: unknown;
  readonly location?: unknown;
}

/**
 * Compute the `clientSign` query parameter the sts URL requires.
 * Algorithm: base64(SHA1(`nonce=<nonce>&<ssecurity>`)).
 */
function computeClientSign(nonce: string, ssecurity: string): string {
  const hash = crypto.createHash('sha1');
  hash.update(`nonce=${nonce}&${ssecurity}`, 'utf-8');
  return hash.digest('base64');
}

/**
 * Append `clientSign` to a URL, preserving any existing query string.
 * The value is URL-encoded because base64 may include `+` / `/` / `=`.
 */
function appendClientSign(url: string, clientSign: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}clientSign=${encodeURIComponent(clientSign)}`;
}

/**
 * Extract a single cookie value from one or more `Set-Cookie` header
 * lines. Returns the raw value with surrounding double quotes
 * stripped, or `null` when the cookie is absent or marked expired.
 */
function pickCookie(
  setCookieLines: readonly string[] | undefined,
  name: string,
): string | null {
  if (!setCookieLines) return null;
  const prefix = `${name}=`;
  for (const line of setCookieLines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(prefix)) continue;
    const headPart = trimmed.split(';', 1)[0]!;
    let value = headPart.slice(prefix.length);
    // Xiaomi sends "..." (quoted) for the api-platform_serviceToken.
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, value.length - 1);
    }
    if (value.length === 0 || value === 'EXPIRED') continue;
    return value;
  }
  return null;
}

/**
 * Strip the `&&&START&&&` anti-XSSI prefix and parse the remainder
 * as JSON. Returns `null` when the body is malformed.
 */
function parseServiceLoginBody(body: string): ServiceLoginResponse | null {
  const trimmed = body.startsWith(JSON_PREFIX)
    ? body.slice(JSON_PREFIX.length)
    : body;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return asRecord(parsed) as ServiceLoginResponse | null;
  } catch {
    return null;
  }
}

/**
 * Xiaomi returns `nonce` as a 19-digit JSON number that overflows
 * JavaScript's `Number.MAX_SAFE_INTEGER` (~9 × 10^15). `JSON.parse`
 * silently casts it to the nearest representable double, which
 * loses precision and produces a different digit string when
 * rendered back. Since the nonce feeds straight into a SHA1 hash
 * (the `clientSign` computation), even a single-digit drift breaks
 * authentication. We therefore lift the verbatim digit run out of
 * the raw response body before JSON parsing happens.
 *
 * Returns `null` when the body is unrecognised or when `nonce`
 * appears as a non-numeric value (in which case we fall through to
 * the parsed JSON result, which preserves string nonces correctly).
 */
function extractRawNonce(body: string): string | null {
  const trimmed = body.startsWith(JSON_PREFIX)
    ? body.slice(JSON_PREFIX.length)
    : body;
  const match = /"nonce"\s*:\s*(-?\d+)/.exec(trimmed);
  return match === null ? null : match[1]!;
}

/**
 * Format a decimal-string field from the balance payload as a
 * human-readable token, falling back to `0` for unparseable inputs.
 */
function formatDecimal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  // Preserve the original string when it parses cleanly so we don't
  // round 24.63 -> 24.629999... back to a floating point.
  return trimmed;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createXiaomiAdapter(
  deps: XiaomiAdapterDeps = {},
): ProviderAdapter {
  const doRequest = deps.requestRaw ?? requestRaw;
  const cache = deps.serviceTokenCache ?? new Map<string, string>();

  /**
   * Run steps 2.a/2.b/2.c above and return a fresh serviceToken.
   * Throws `ProviderAdapterError('auth_expired'|'auth_missing'|...)` on
   * recoverable failures so the outer `refresh` can surface a typed
   * unavailable snapshot.
   */
  async function exchangePassToken(
    passToken: string,
    userId: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    // Step 1: passToken -> sts location
    const loginResp = await doRequest({
      url: SERVICE_LOGIN_URL,
      method: 'GET',
      ...(signal !== undefined ? { signal } : {}),
      headers: {
        Cookie: `passToken=${passToken}; userId=${userId}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (loginResp.status !== 200) {
      throw new ProviderAdapterError(
        loginResp.status === 401 || loginResp.status === 403
          ? 'auth_expired'
          : 'upstream_changed',
        `serviceLogin returned HTTP ${loginResp.status}`,
      );
    }

    const parsed = parseServiceLoginBody(loginResp.body);
    if (parsed === null) {
      throw new ProviderAdapterError(
        'upstream_changed',
        'serviceLogin response was not JSON',
      );
    }
    // Recover `nonce` as a verbatim string from the raw body —
    // JSON.parse cannot represent 19-digit nonces without losing
    // precision (see `extractRawNonce` for the full rationale).
    // Fall back to whatever the parsed value yielded if the regex
    // misses (e.g. when the upstream switches to a quoted string).
    const rawNonce = extractRawNonce(loginResp.body);
    const nonce =
      rawNonce !== null
        ? rawNonce
        : typeof parsed.nonce === 'string'
          ? parsed.nonce
          : null;
    const ssecurity =
      typeof parsed.ssecurity === 'string' ? parsed.ssecurity : null;
    const location =
      typeof parsed.location === 'string' ? parsed.location : null;
    if (!nonce || !ssecurity || !location) {
      // No `location` typically means the passToken was rejected.
      throw new ProviderAdapterError(
        'auth_expired',
        'serviceLogin response missing fields (passToken expired?)',
      );
    }

    // Step 2: derive clientSign and hit the sts URL.
    const clientSign = computeClientSign(nonce, ssecurity);
    const stsUrl = appendClientSign(location, clientSign);
    const stsResp = await doRequest({
      url: stsUrl,
      method: 'GET',
      ...(signal !== undefined ? { signal } : {}),
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (stsResp.status !== 200) {
      throw new ProviderAdapterError(
        'upstream_changed',
        `sts handshake returned HTTP ${stsResp.status}`,
      );
    }

    const serviceToken = pickCookie(
      stsResp.headers['set-cookie'],
      SERVICE_TOKEN_COOKIE,
    );
    if (serviceToken === null) {
      throw new ProviderAdapterError(
        'upstream_changed',
        'sts response missing serviceToken cookie',
      );
    }
    return serviceToken;
  }

  /**
   * Read a platform endpoint with the cached / refreshed
   * serviceToken cookie. On 401 invalidates the cache, exchanges a
   * fresh token via passToken, and retries once. Any 401 after the
   * retry is reported as `auth_expired`.
   *
   * Generic over GET/POST so both the balance read (GET, no body)
   * and the usage detail list (POST, JSON body) can share the
   * cookie-management logic.
   */
  async function callWithCookie(
    accountId: string,
    passToken: string,
    userId: string,
    signal: AbortSignal | undefined,
    request: {
      url: string;
      method: 'GET' | 'POST';
      body?: unknown;
      label: string;
    },
  ): Promise<unknown> {
    const send = async (token: string): Promise<{
      readonly status: number;
      readonly body: string;
    }> => {
      const headers: Record<string, string> = {
        Cookie: `${SERVICE_TOKEN_COOKIE}=${token}; userId=${userId}`,
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      };
      const r = await doRequest({
        url: request.url,
        method: request.method,
        ...(signal !== undefined ? { signal } : {}),
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
      return { status: r.status, body: r.body };
    };

    // Try the cached token first, fall back to a fresh exchange on 401.
    let token = cache.get(accountId);
    if (token !== undefined) {
      const r = await send(token);
      if (r.status !== 401) {
        if (r.status >= 200 && r.status < 300) {
          try {
            return JSON.parse(r.body) as unknown;
          } catch {
            throw new ProviderAdapterError(
              'upstream_changed',
              `${request.label} response was not JSON`,
            );
          }
        }
        throw new ProviderAdapterError(
          'upstream_changed',
          `${request.label} returned HTTP ${r.status}`,
        );
      }
      cache.delete(accountId);
    }

    // Exchange + retry (one attempt only).
    token = await exchangePassToken(passToken, userId, signal);
    cache.set(accountId, token);
    const r = await send(token);
    if (r.status === 401 || r.status === 403) {
      cache.delete(accountId);
      throw new ProviderAdapterError(
        'auth_expired',
        `${request.label} rejected freshly-issued serviceToken`,
      );
    }
    if (r.status < 200 || r.status >= 300) {
      throw new ProviderAdapterError(
        'upstream_changed',
        `${request.label} returned HTTP ${r.status}`,
      );
    }
    try {
      return JSON.parse(r.body) as unknown;
    } catch {
      throw new ProviderAdapterError(
        'upstream_changed',
        `${request.label} response was not JSON`,
      );
    }
  }

  function fetchBalance(
    accountId: string,
    passToken: string,
    userId: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    return callWithCookie(accountId, passToken, userId, signal, {
      url: BALANCE_URL,
      method: 'GET',
      label: 'balance',
    });
  }

  /**
   * Pull this calendar month's per-day usage from
   * `/api/v1/usage/detail`. Failures are non-fatal — the
   * adapter logs nothing and the snapshot keeps going without a
   * `dailyUsage` field. We deliberately fetch only the current
   * month (`?year=&month=`) so the response stays small enough
   * for the platform's pagination contract; the renderer then
   * trims to the most recent ~30 days for the sparkline.
   *
   * Endpoint changed June 2026: was POST /api/v1/usage/detail/list
   * with JSON body; now GET /api/v1/usage/detail?year=YYYY&month=M.
   */
  async function fetchDailyUsage(
    accountId: string,
    passToken: string,
    userId: string,
    nowMs: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly { date: string; cost: string; totalTokens: number }[]> {
    const d = new Date(nowMs);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const url = `${USAGE_DETAIL_URL}?year=${year}&month=${month}`;
    const response = await callWithCookie(accountId, passToken, userId, signal, {
      url,
      method: 'GET',
      label: 'usage/detail',
    });
    return parseDailyUsageResponse(response, year);
  }

  return {
    provider: 'xiaomi',
    capability: 'official',
    async refresh({ account, getSecret, now, signal }) {
      const secret = getSecret();
      if (secret === null) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'Xiaomi credentials are missing',
          'credits',
        );
      }

      const passToken =
        typeof secret.xiaomiPassToken === 'string'
          ? secret.xiaomiPassToken.trim()
          : '';
      const userId =
        typeof secret.xiaomiUserId === 'string'
          ? secret.xiaomiUserId.trim()
          : '';
      if (passToken.length === 0 || userId.length === 0) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'Xiaomi requires passToken and userId cookies',
          'credits',
        );
      }

      let response: unknown;
      try {
        response = await fetchBalance(account.id, passToken, userId, signal);
      } catch (err) {
        if (err instanceof ProviderAdapterError) {
          return unavailableSnapshot(
            account,
            now,
            err.code,
            err.message,
            'credits',
          );
        }
        return unavailableSnapshot(
          account,
          now,
          'network_error',
          'Xiaomi balance request failed',
          'credits',
        );
      }

      const parsed = parseBalanceResponse(response);

      // Fetch daily usage in parallel-ish: the balance call already
      // succeeded (so the cookie is fresh), but we still treat the
      // usage call as best-effort — failures don't downgrade the
      // snapshot status. If the user just added the account and
      // hasn't run any inference yet the response is empty, which
      // is fine: `dailyUsage: []` distinguishes "no usage yet" from
      // "this adapter doesn't expose usage" (= undefined).
      let dailyUsage: ReadonlyArray<DailyUsagePoint> | null = null;
      try {
        dailyUsage = await fetchDailyUsage(
          account.id,
          passToken,
          userId,
          now,
          signal,
        );
      } catch {
        // Best-effort. The balance + currency strip continue to
        // render; the sparkline simply does not appear.
      }

      return okSnapshot(account, now, parsed.windows, {
        kind: 'credits',
        rawPlanLabel: parsed.rawPlanLabel,
        ...(dailyUsage !== null ? { dailyUsage } : {}),
      });
    },
  };
}

/**
 * Translate the upstream balance payload into one or more
 * QuotaWindow rows. Mirrors the DeepSeek adapter's `credits:<currency>
 * 总额 X / 现金 Y / 赠金 Z` window-name convention so the renderer's
 * existing credits-window parser (`renderer/lib/quota-display.ts`)
 * handles the result without changes.
 */
function parseBalanceResponse(response: unknown): {
  readonly windows: Array<{
    readonly name: string;
    readonly percentLeft: number | null;
    readonly resetAt: null;
    readonly windowSeconds: null;
  }>;
  readonly rawPlanLabel: string | null;
} {
  const root = asRecord(response);
  if (root === null) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'Xiaomi balance response was not an object',
    );
  }

  // `code === 0` is the success contract for the platform's
  // application-level envelope. Anything else is upstream-changed
  // (the HTTP layer already rejected non-2xx).
  if (root['code'] !== 0 && root['code'] !== '0') {
    throw new ProviderAdapterError(
      'upstream_changed',
      'Xiaomi balance returned non-zero application code',
    );
  }

  const data = asRecord(root['data']);
  if (data === null) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'Xiaomi balance response missing data',
    );
  }

  const currency =
    typeof data['currency'] === 'string' && data['currency'].trim().length > 0
      ? data['currency'].trim()
      : 'UNKNOWN';
  const total = formatDecimal(data['balance']);
  const cash = formatDecimal(data['cashBalance']);
  const gift = formatDecimal(data['giftBalance']);
  const frozen = formatDecimal(data['frozenBalance']);

  if (total === null && cash === null && gift === null) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'Xiaomi balance response missing balance fields',
    );
  }

  const parts = [
    total === null ? null : `总额 ${total}`,
    cash === null ? null : `现金 ${cash}`,
    gift === null ? null : `赠金 ${gift}`,
    frozen === null || frozen === '0' || frozen === '0.00'
      ? null
      : `冻结 ${frozen}`,
  ].filter((part): part is string => part !== null);

  const name = `credits:${currency} ${parts.join(' / ')}`;

  // Xiaomi does not surface a binary "is_available" flag; we leave
  // percentLeft as null so the UI shows the textual breakdown only,
  // matching DeepSeek's behaviour when only currency strings are
  // returned.
  return {
    windows: [{
      name,
      percentLeft: null,
      resetAt: null,
      windowSeconds: null,
    }],
    rawPlanLabel: name.slice('credits:'.length),
  };
}

export const xiaomiAdapter: ProviderAdapter = createXiaomiAdapter();

// ---------------------------------------------------------------------------
// Daily usage parser
// ---------------------------------------------------------------------------

/**
 * Aggregate the response from `/api/v1/usage/detail` into a
 * date-keyed `DailyUsagePoint` array.
 *
 * NEW format (June 2026):
 *   { code: 0, data: { tokenUsage: [["MM-DD", prompt, completion,
 *     total, cumPrompt, cumCompletion], ...], requests: [...] } }
 *   Dates are "MM-DD" strings; we reconstruct "YYYY-MM-DD" from
 *   the query params. The platform no longer returns cost amounts
 *   — only token counts.
 *
 * OLD format (for backward compatibility if the platform rolls back):
 *   [{ date, model, apiKey, totalToken, consumedAmount }, ...]
 *   or { code: 0, data: [...] }
 *   or { code: 0, data: { list/rows/records: [...] } }
 */
function parseDailyUsageResponse(
  response: unknown,
  year: number,
): readonly DailyUsagePoint[] {

  // Try NEW dense-array format first
  const root = asRecord(response);
  if (root !== null && root['code'] === 0) {
    const data = asRecord(root['data']);
    if (data !== null) {
      const tokenUsage = Array.isArray(data['tokenUsage'])
        ? (data['tokenUsage'] as readonly unknown[])
        : null;

      if (tokenUsage !== null && tokenUsage.length > 0) {
        // date -> { cost, totalTokens }
        const byDate = new Map<string, { cost: number; totalTokens: number }>();

        for (const raw of tokenUsage) {
          if (!Array.isArray(raw)) continue;
          const arr = raw as readonly unknown[];
          // Columns: [0]=date(MM-DD), [1]=prompt, [2]=completion, [3]=total, ...
          if (arr.length < 4) continue;
          const dateStr = typeof arr[0] === 'string' ? arr[0].trim() : '';
          if (dateStr.length === 0) continue;
          const fullDate = `${year}-${dateStr}`; // dateStr is "MM-DD"
          const totalTokens = parseInteger(arr[3]); // column [3] = total tokens

          const existing = byDate.get(fullDate) ?? { cost: 0, totalTokens: 0 };
          if (totalTokens !== null) existing.totalTokens += totalTokens;
          byDate.set(fullDate, existing);
        }

        return Array.from(byDate.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, agg]) => ({
            date,
            cost: '0', // new API no longer returns cost amounts
            totalTokens: agg.totalTokens,
          }));
      }
    }
  }

  // Fall back to OLD format: array of { date, model, totalToken, consumedAmount }
  const rows = extractUsageRows(response);
  if (rows === null) return [];

  const byDate = new Map<string, { cost: number; totalTokens: number }>();

  for (const raw of rows) {
    const row = asRecord(raw);
    if (row === null) continue;
    const date = typeof row['date'] === 'string' ? row['date'].trim() : '';
    if (date.length === 0) continue;

    const cost = parseDecimal(row['consumedAmount']);
    const totalTokens = parseInteger(row['totalToken']);

    const existing = byDate.get(date) ?? { cost: 0, totalTokens: 0 };
    if (cost !== null) existing.cost += cost;
    if (totalTokens !== null) existing.totalTokens += totalTokens;
    byDate.set(date, existing);
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, agg]) => ({
      date,
      cost: formatCostString(agg.cost),
      totalTokens: agg.totalTokens,
    }));
}

function extractUsageRows(response: unknown): readonly unknown[] | null {
  if (Array.isArray(response)) return response;
  const root = asRecord(response);
  if (root === null) return null;
  if (Array.isArray(root['data'])) return root['data'] as readonly unknown[];
  const data = asRecord(root['data']);
  if (data !== null) {
    if (Array.isArray(data['list'])) return data['list'] as readonly unknown[];
    if (Array.isArray(data['rows'])) return data['rows'] as readonly unknown[];
    if (Array.isArray(data['records'])) return data['records'] as readonly unknown[];
  }
  return null;
}

function parseDecimal(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseInteger(value: unknown): number | null {
  const numeric = parseDecimal(value);
  if (numeric === null) return null;
  return Math.max(0, Math.round(numeric));
}

function formatCostString(value: number): string {
  // Two decimals for non-zero monetary values; "0" for exactly zero.
  if (value === 0) return '0';
  return value.toFixed(Math.abs(value) < 100 ? 4 : 2);
}
