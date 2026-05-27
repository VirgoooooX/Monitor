// DeepSeek provider adapter.
//
// Two data paths, picked at runtime:
//
//   A. Public path (default):
//      `GET https://api.deepseek.com/user/balance` with the user's
//      sk- API key as `Authorization: Bearer`. Returns the
//      multi-currency balance envelope documented in
//      api-docs.deepseek.com. Cheap, stable, but no per-day usage
//      breakdown — only the current balance + a boolean
//      availability flag.
//
//   B. Console path (opt-in):
//      The platform's React app keeps the user's session token in
//      `localStorage` under key `userToken` and stamps every IPC
//      call with `Authorization: Bearer <userToken>`. When the
//      user pastes that token into Monitor we can call the same
//      console endpoints the platform uses:
//        - `GET /api/v0/users/get_user_summary`
//          → multi-wallet balance breakdown (normal / bonus
//             wallets, monthly usage, etc.)
//        - `GET /api/v0/usage/cost?year=YYYY&month=M`
//          → per-day spend, used to feed the sparkline.
//
// The adapter prefers (B) when `secret.deepseekUserToken` is
// present so the renderer surfaces strictly more data; on any
// failure of (B) we fall back to (A) so a stale console token
// never hides the balance entirely.
//
// Privacy:
//   - The userToken / API key are NEVER written to logs or error
//     messages. Console-token failures collapse to short, generic
//     strings (`'console summary failed'`).

import {
  asRecord,
  okSnapshot,
  ProviderAdapterError,
  requestJson,
  type RequestJson,
  unavailableSnapshot,
} from './common';
import type { ProviderAdapter } from './types';
import type { DailyUsagePoint, QuotaWindow } from '../../../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PUBLIC_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const CONSOLE_USER_SUMMARY_URL =
  'https://platform.deepseek.com/api/v0/users/get_user_summary';
const CONSOLE_USAGE_COST_URL =
  'https://platform.deepseek.com/api/v0/usage/cost';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface DeepSeekAdapterDeps {
  readonly requestJson?: RequestJson;
}

export function createDeepSeekAdapter(
  deps: DeepSeekAdapterDeps = {},
): ProviderAdapter {
  const doRequest = deps.requestJson ?? requestJson;

  return {
    provider: 'deepseek',
    capability: 'official',
    async refresh({ account, getSecret, now, signal }) {
      const secret = getSecret();
      if (secret === null) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'DeepSeek credentials are missing',
          'credits',
        );
      }

      const apiKey =
        typeof secret.apiKey === 'string' ? secret.apiKey.trim() : '';
      const userToken =
        typeof secret.deepseekUserToken === 'string'
          ? secret.deepseekUserToken.trim()
          : '';

      // Prefer the console path when a userToken is configured —
      // it carries strictly more information than the public
      // balance endpoint and unlocks the daily-usage sparkline.
      if (userToken.length > 0) {
        const consoleResult = await tryConsolePath(
          doRequest,
          userToken,
          now,
          signal,
        );
        if (consoleResult !== null) {
          return okSnapshot(account, now, consoleResult.windows, {
            kind: 'credits',
            rawPlanLabel: consoleResult.rawPlanLabel,
            ...(consoleResult.dailyUsage !== null
              ? { dailyUsage: consoleResult.dailyUsage }
              : {}),
          });
        }
        // Console path failed — fall through to the public balance
        // path so the user still sees a number. We do NOT surface
        // the userToken failure as a separate error: a stale
        // console token simply downgrades the experience to the
        // sk-key path.
      }

      if (apiKey.length === 0) {
        // No usable credentials at all (no API key and either no
        // userToken or the userToken path failed).
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'DeepSeek API key is missing',
          'credits',
        );
      }

      const response = await doRequest<unknown>({
        url: PUBLIC_BALANCE_URL,
        method: 'GET',
        ...(signal !== undefined ? { signal } : {}),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      });

      const parsed = parsePublicBalance(response);
      return okSnapshot(account, now, parsed.windows, {
        kind: 'credits',
        rawPlanLabel: parsed.rawPlanLabel,
      });
    },
  };
}

export const deepseekAdapter: ProviderAdapter = createDeepSeekAdapter();

// ---------------------------------------------------------------------------
// Public balance path (sk- API key)
// ---------------------------------------------------------------------------

interface PublicBalanceParseResult {
  readonly windows: QuotaWindow[];
  readonly rawPlanLabel: string | null;
}

function parsePublicBalance(response: unknown): PublicBalanceParseResult {
  const root = asRecord(response);
  const infos = Array.isArray(root?.['balance_infos'])
    ? root['balance_infos']
    : null;
  if (root === null || infos === null) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'DeepSeek balance response missing balance_infos',
    );
  }

  const windows: QuotaWindow[] = infos.flatMap((entry) => {
    const record = asRecord(entry);
    if (record === null) return [];
    const currency = stringValue(record['currency']) ?? 'UNKNOWN';
    const total = stringValue(record['total_balance']);
    const granted = stringValue(record['granted_balance']);
    const toppedUp = stringValue(record['topped_up_balance']);
    if (total === null && granted === null && toppedUp === null) return [];

    const parts = [
      total === null ? null : `总额 ${total}`,
      granted === null ? null : `赠金 ${granted}`,
      toppedUp === null ? null : `充值 ${toppedUp}`,
    ].filter((part): part is string => part !== null);

    return [{
      name: `credits:${currency} ${parts.join(' / ')}`,
      percentLeft: availablePercent(root['is_available']),
      resetAt: null,
      windowSeconds: null,
    } satisfies QuotaWindow];
  });

  if (windows.length === 0) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'DeepSeek balance response missing balances',
    );
  }

  return {
    windows,
    rawPlanLabel: windows.map((window) =>
      window.name.slice('credits:'.length),
    ).join(' · '),
  };
}

// ---------------------------------------------------------------------------
// Console path (Bearer userToken)
// ---------------------------------------------------------------------------

interface ConsolePathResult {
  readonly windows: QuotaWindow[];
  readonly rawPlanLabel: string | null;
  readonly dailyUsage: ReadonlyArray<DailyUsagePoint> | null;
}

/**
 * Returns the parsed console-path snapshot or `null` when the
 * console call failed for any reason. Failures are NEVER thrown
 * out of this function — the caller falls back to the public
 * balance path on `null` so a stale userToken never blocks the
 * basic balance read.
 */
async function tryConsolePath(
  doRequest: RequestJson,
  userToken: string,
  now: number,
  signal: AbortSignal | undefined,
): Promise<ConsolePathResult | null> {
  let summary: unknown;
  try {
    summary = await doRequest<unknown>({
      url: CONSOLE_USER_SUMMARY_URL,
      method: 'GET',
      ...(signal !== undefined ? { signal } : {}),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
    });
  } catch {
    return null;
  }

  let parsed: ConsoleSummaryParseResult;
  try {
    parsed = parseConsoleSummary(summary);
  } catch {
    return null;
  }

  // Daily-usage call is best-effort — if it fails we still return
  // the balance windows from the summary call.
  let dailyUsage: ReadonlyArray<DailyUsagePoint> | null = null;
  try {
    const d = new Date(now);
    const usage = await doRequest<unknown>({
      url:
        CONSOLE_USAGE_COST_URL +
        `?year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}`,
      method: 'GET',
      ...(signal !== undefined ? { signal } : {}),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
    });
    dailyUsage = parseConsoleUsageCost(usage);
  } catch {
    // Ignore — daily usage stays null.
  }

  return {
    windows: parsed.windows,
    rawPlanLabel: parsed.rawPlanLabel,
    dailyUsage,
  };
}

interface ConsoleSummaryParseResult {
  readonly windows: QuotaWindow[];
  readonly rawPlanLabel: string | null;
}

/**
 * Parse the `get_user_summary` envelope. Schema (extracted from
 * the platform.deepseek.com bundle):
 *
 *   {
 *     code: 0,
 *     data: {
 *       biz_data: {
 *         current_token: number,           // estimated tokens at current price
 *         total_usage: ... ,
 *         monthly_usage: ... ,
 *         total_available_token_estimation: number,
 *         monthly_costs: [{currency, amount}, ...],
 *         normal_wallets: [{balance, currency, token_estimation}, ...],
 *         bonus_wallets: [{balance, currency, token_estimation}, ...],
 *       }
 *     }
 *   }
 *
 * We synthesise one credits-style QuotaWindow per (currency, wallet
 * kind) pair so the renderer can show "总额" / "现金" / "赠金"
 * decomposition the same way it does for Xiaomi and the public
 * balance path.
 */
function parseConsoleSummary(response: unknown): ConsoleSummaryParseResult {
  const root = asRecord(response);
  if (root === null) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'console summary response was not an object',
    );
  }

  const data = asRecord(root['data']);
  const bizData = data === null ? null : asRecord(data['biz_data']);
  if (bizData === null) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'console summary missing biz_data',
    );
  }

  const normal = Array.isArray(bizData['normal_wallets'])
    ? bizData['normal_wallets']
    : [];
  const bonus = Array.isArray(bizData['bonus_wallets'])
    ? bizData['bonus_wallets']
    : [];

  // Combine normal + bonus per currency. The renderer's existing
  // credits-window parser splits on `总额 / 现金 / 赠金` slashes.
  const byCurrency = new Map<string, { cash: number; bonus: number }>();
  for (const entry of normal) {
    const r = asRecord(entry);
    if (r === null) continue;
    const ccy = stringValue(r['currency']) ?? 'UNKNOWN';
    const balance = numericValue(r['balance']);
    if (balance === null) continue;
    const agg = byCurrency.get(ccy) ?? { cash: 0, bonus: 0 };
    agg.cash += balance;
    byCurrency.set(ccy, agg);
  }
  for (const entry of bonus) {
    const r = asRecord(entry);
    if (r === null) continue;
    const ccy = stringValue(r['currency']) ?? 'UNKNOWN';
    const balance = numericValue(r['balance']);
    if (balance === null) continue;
    const agg = byCurrency.get(ccy) ?? { cash: 0, bonus: 0 };
    agg.bonus += balance;
    byCurrency.set(ccy, agg);
  }

  if (byCurrency.size === 0) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'console summary contained no wallets',
    );
  }

  const windows: QuotaWindow[] = [];
  const labels: string[] = [];
  for (const [currency, agg] of Array.from(byCurrency.entries())) {
    const total = agg.cash + agg.bonus;
    const parts = [
      `总额 ${formatBalance(total)}`,
      agg.cash > 0 ? `现金 ${formatBalance(agg.cash)}` : null,
      agg.bonus > 0 ? `赠金 ${formatBalance(agg.bonus)}` : null,
    ].filter((part): part is string => part !== null);
    const name = `credits:${currency} ${parts.join(' / ')}`;
    windows.push({
      name,
      percentLeft: null,
      resetAt: null,
      windowSeconds: null,
    });
    labels.push(name.slice('credits:'.length));
  }

  return {
    windows,
    rawPlanLabel: labels.join(' · '),
  };
}

/**
 * Aggregate the `usage/cost` envelope into a date-keyed
 * `DailyUsagePoint` array. Shape in the wild (extracted from the
 * platform bundle's destructure pattern):
 *
 *   { data: { biz_data: [{ currency, total, days: [{day, cost}, ...] }] } }
 *      or
 *   { data:           [{ currency, total, days: [{day, cost}, ...] }]    }
 *
 * The bundle treats both shapes; we follow the same logic. The
 * `day`-side field name for the date and amount is not surfaced
 * verbatim in the bundle, so we accept several common spellings
 * (`day`/`date` for the date, `cost`/`amount`/`fee` for the
 * value). Multiple currency rows are summed per-day; if multiple
 * currencies coexist we still produce one bar series — the
 * renderer's tooltip format is currency-agnostic.
 */
function parseConsoleUsageCost(
  response: unknown,
): ReadonlyArray<DailyUsagePoint> {
  const root = asRecord(response);
  if (root === null) return [];
  const dataField = root['data'];
  let series: readonly unknown[];
  if (Array.isArray(dataField)) {
    series = dataField;
  } else {
    const dataRecord = asRecord(dataField);
    const biz = dataRecord === null ? null : dataRecord['biz_data'];
    series = Array.isArray(biz) ? biz : [];
  }
  if (series.length === 0) return [];

  // date -> aggregated cost
  const byDate = new Map<string, { cost: number; tokens: number }>();
  for (const entry of series) {
    const r = asRecord(entry);
    if (r === null) continue;
    const days = Array.isArray(r['days']) ? r['days'] : [];
    for (const dayEntry of days) {
      const d = asRecord(dayEntry);
      if (d === null) continue;
      const dateStr = stringValue(d['day']) ?? stringValue(d['date']);
      if (dateStr === null) continue;
      // Normalise to YYYY-MM-DD; some envelopes return a Date-ish
      // ISO string with a time component.
      const isoOnly = dateStr.length >= 10 ? dateStr.slice(0, 10) : dateStr;
      const cost =
        numericValue(d['cost']) ??
        numericValue(d['amount']) ??
        numericValue(d['fee']);
      const tokens =
        numericValue(d['tokens']) ??
        numericValue(d['total_token']) ??
        numericValue(d['total_tokens']) ??
        0;
      if (cost === null) continue;
      const agg = byDate.get(isoOnly) ?? { cost: 0, tokens: 0 };
      agg.cost += cost;
      agg.tokens += tokens;
      byDate.set(isoOnly, agg);
    }
  }

  if (byDate.size === 0) return [];

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, agg]) => ({
      date,
      cost: formatBalance(agg.cost),
      totalTokens: agg.tokens,
    }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatBalance(value: number): string {
  if (value === 0) return '0';
  // Two decimals when the value is small enough that fractional
  // cents matter; integer formatting otherwise to match the
  // platform's typical display.
  return value.toFixed(Math.abs(value) < 100 ? 2 : 2);
}

function availablePercent(value: unknown): number | null {
  return typeof value === 'boolean' ? (value ? 100 : 0) : null;
}
