// Codex quota / rate-limits collector.
//
// Two data sources:
//   1. Local: Parse `rate_limits` fields from session JSONL (passive, free).
//   2. Remote: Query `chatgpt.com/backend-api/wham/usage` (active, throttled).
//
// The local source captures snapshots embedded in `token_count` events
// written by Codex CLI after each API call. The remote source calls
// ChatGPT's internal usage endpoint using OAuth credentials stored in
// `~/.codex/auth.json`.
//
// References:
//   - https://github.com/SC123667/codex-monitor (rolling 5h logic)
//   - https://github.com/XertroV/quotas (API endpoint discovery)
//   - https://knightli.com/en/2026/04/12/codex-usage-quota-check/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';

import type {
  ProviderAuthErrorCode,
  QuotaSnapshot,
  QuotaWindow,
} from '../../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CodexAuthJson {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface RateLimitWindow {
  percent_left?: number;
  remaining_percent?: number;
  used_percent?: number;
  reset_time_ms?: number;
  reset_at?: number;
  limit_window_seconds?: number;
}

interface WhamUsageResponse {
  rate_limit?: {
    five_hour?: RateLimitWindow;
    five_hour_limit?: RateLimitWindow;
    five_hour_rate_limit?: RateLimitWindow;
    primary?: RateLimitWindow;
    primary_window?: RateLimitWindow;
    weekly?: RateLimitWindow;
    weekly_limit?: RateLimitWindow;
    weekly_rate_limit?: RateLimitWindow;
    secondary?: RateLimitWindow;
    secondary_window?: RateLimitWindow;
  };
  rate_limits?: WhamUsageResponse['rate_limit'];
  code_review_rate_limit?: WhamUsageResponse['rate_limit'];
  additional_rate_limits?: unknown;
}

export class CodexRemoteQuotaError extends Error {
  override readonly name = 'CodexRemoteQuotaError';

  constructor(
    public readonly code: ProviderAuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CodexRemoteQuotaAuth {
  readonly accessToken: string;
  readonly accountId: string;
  readonly capturedAt?: number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Local JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Scan the most recent Codex session JSONL files for embedded
 * `rate_limits` snapshots. Returns the latest snapshot found, or null.
 */
export async function parseLocalRateLimits(): Promise<QuotaSnapshot | null> {
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');

  try {
    await fs.promises.access(sessionsRoot, fs.constants.R_OK);
  } catch {
    return null;
  }

  // Find the most recent day directory
  const recentFile = await findMostRecentJsonl(sessionsRoot);
  if (!recentFile) return null;

  // Read the file and scan from the end for rate_limits
  let content: string;
  try {
    content = await fs.promises.readFile(recentFile, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  // Scan from the end — most recent events are at the bottom
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;

    // Quick check before expensive JSON parse
    if (!line.includes('rate_limit')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const rateLimits = extractRateLimitsFromRecord(parsed);
    if (rateLimits) {
      const timestamp = extractTimestampFromRecord(parsed) ?? Date.now();
      return {
        provider: 'codex',
        capturedAt: timestamp,
        source: 'local_log',
        windows: rateLimits,
        providerAuthId: null,
        accountLabel: null,
        accountId: null,
        projectId: null,
        kind: 'quota',
        status: 'ok',
        rawPlanLabel: null,
        modelGroup: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      };
    }
  }

  return null;
}

export function extractRateLimitsFromRecord(record: unknown): QuotaWindow[] | null {
  if (!record || typeof record !== 'object') return null;

  // Navigate into nested structures:
  // { type: "event_msg", payload: { type: "token_count", info: { rate_limits: {...} } } }
  // Or directly: { rate_limits: {...} }
  let rateLimitsObj = deepGet(record, 'rate_limits') ?? deepGet(record, 'rate_limit');

  if (!rateLimitsObj) {
    // Try nested path for Codex event format
    rateLimitsObj =
      deepGet(record, 'payload', 'info', 'rate_limits') ??
      deepGet(record, 'payload', 'info', 'rate_limit') ??
      deepGet(record, 'payload', 'rate_limits') ??
      deepGet(record, 'payload', 'rate_limit');
  }

  if (!rateLimitsObj || typeof rateLimitsObj !== 'object') return null;

  const windows: QuotaWindow[] = [];
  const obj = rateLimitsObj as Record<string, unknown>;
  appendStandardRateLimitWindows(windows, obj, '');

  const codeReviewRateLimit = deepGet(record, 'code_review_rate_limit');
  if (codeReviewRateLimit && typeof codeReviewRateLimit === 'object') {
    appendStandardRateLimitWindows(
      windows,
      codeReviewRateLimit as Record<string, unknown>,
      'code_review:',
    );
  }

  const additionalRateLimits = deepGet(record, 'additional_rate_limits');
  if (additionalRateLimits !== undefined) {
    appendAdditionalRateLimitWindows(windows, additionalRateLimits, 'additional');
  }

  // If we only got one window, try to infer its type from window_seconds
  if (windows.length === 1 && windows[0]) {
    const ws = windows[0].windowSeconds;
    if (ws && ws >= 6 * 24 * 3600 && windows[0].name === '5h') {
      windows[0].name = 'weekly';
    }
  }

  return windows.length > 0 ? dedupeQuotaWindows(windows) : null;
}

function appendStandardRateLimitWindows(
  windows: QuotaWindow[],
  obj: Record<string, unknown>,
  prefix: string,
): void {
  // Try to extract 5h window
  const fiveHour = findWindow(obj, [
    'five_hour', 'five_hour_limit', 'five_hour_rate_limit',
    'primary', 'primary_window',
  ]);
  if (fiveHour) {
    windows.push({ name: `${prefix}5h`, ...fiveHour });
  }

  // Try to extract weekly window
  const weekly = findWindow(obj, [
    'weekly', 'weekly_limit', 'weekly_rate_limit',
    'secondary', 'secondary_window',
  ]);
  if (weekly) {
    windows.push({ name: `${prefix}weekly`, ...weekly });
  }
}

function appendAdditionalRateLimitWindows(
  windows: QuotaWindow[],
  value: unknown,
  nameHint: string,
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      appendAdditionalRateLimitWindows(windows, value[i], `${nameHint}:${i + 1}`);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  const direct = windowFromObject(obj);
  if (direct) {
    const explicitName =
      stringField(obj, 'name') ??
      stringField(obj, 'model') ??
      stringField(obj, 'bucket') ??
      nameHint;
    windows.push({ name: explicitName, ...direct });
  }

  for (const [key, child] of Object.entries(obj)) {
    if (key === 'name' || key === 'model' || key === 'bucket') continue;
    appendAdditionalRateLimitWindows(windows, child, `${nameHint}:${key}`);
  }
}

function findWindow(
  obj: Record<string, unknown>,
  keys: string[],
): Omit<QuotaWindow, 'name'> | null {
  for (const key of keys) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const parsed = windowFromObject(val as Record<string, unknown>);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function windowFromObject(w: Record<string, unknown>): Omit<QuotaWindow, 'name'> | null {
  const percentLeft = getPercentLeft(w);
  const resetAt = getResetAt(w);
  const windowSeconds = typeof w['limit_window_seconds'] === 'number'
    ? w['limit_window_seconds'] as number
    : null;

  if (percentLeft !== null || resetAt !== null || windowSeconds !== null) {
    return { percentLeft, resetAt, windowSeconds };
  }
  return null;
}

function getPercentLeft(w: Record<string, unknown>): number | null {
  if (typeof w['percent_left'] === 'number') return w['percent_left'] as number;
  if (typeof w['remaining_percent'] === 'number') return w['remaining_percent'] as number;
  if (typeof w['used_percent'] === 'number') return Math.max(0, 100 - (w['used_percent'] as number));
  return null;
}

function getResetAt(w: Record<string, unknown>): number | null {
  const raw = w['reset_time_ms'] ?? w['reset_at'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  // Distinguish epoch seconds from epoch milliseconds
  return raw > 1e11 ? raw : raw * 1000;
}

function extractTimestampFromRecord(record: unknown): number | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  for (const field of ['timestamp', 'ts', 'created_at', 'time']) {
    const val = r[field];
    if (typeof val === 'number' && val > 0) {
      return val < 1e12 ? val * 1000 : val;
    }
  }
  return null;
}

function deepGet(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function dedupeQuotaWindows(windows: readonly QuotaWindow[]): QuotaWindow[] {
  const out = new Map<string, QuotaWindow>();
  for (const window of windows) {
    const existing = out.get(window.name);
    if (!existing) {
      out.set(window.name, window);
      continue;
    }
    out.set(window.name, {
      name: window.name,
      percentLeft: existing.percentLeft ?? window.percentLeft,
      resetAt: existing.resetAt ?? window.resetAt,
      windowSeconds: existing.windowSeconds ?? window.windowSeconds,
    });
  }
  return Array.from(out.values());
}

async function findMostRecentJsonl(sessionsRoot: string): Promise<string | null> {
  try {
    const years = (await fs.promises.readdir(sessionsRoot))
      .filter((y) => /^\d{4}$/.test(y))
      .sort()
      .reverse();

    for (const year of years) {
      const yearPath = path.join(sessionsRoot, year);
      const months = (await safeReaddir(yearPath))
        .filter((m) => /^\d{2}$/.test(m))
        .sort()
        .reverse();

      for (const month of months) {
        const monthPath = path.join(yearPath, month);
        const days = (await safeReaddir(monthPath))
          .filter((d) => /^\d{2}$/.test(d))
          .sort()
          .reverse();

        for (const day of days) {
          const dayPath = path.join(monthPath, day);
          const files = (await safeReaddir(dayPath))
            .filter((f) => f.endsWith('.jsonl'))
            .sort()
            .reverse();

          if (files.length > 0) {
            return path.join(dayPath, files[0]!);
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Remote API query
// ---------------------------------------------------------------------------

/**
 * Query the official ChatGPT usage endpoint for precise quota status.
 * This helper is credential-source agnostic: callers hand in the
 * already-imported token/account id, so ProviderAuth adapters never
 * need to read `~/.codex/auth.json` themselves.
 */
export async function fetchRemoteQuotaForAuth(
  auth: CodexRemoteQuotaAuth,
): Promise<QuotaSnapshot> {
  const capturedAt = auth.capturedAt ?? Date.now();
  const accessToken = auth.accessToken.trim();
  const accountId = auth.accountId.trim();

  if (accessToken.length === 0 || accountId.length === 0) {
    throw new CodexRemoteQuotaError('auth_missing', 'Codex auth token is missing');
  }
  if (isJwtExpired(accessToken, capturedAt)) {
    throw new CodexRemoteQuotaError('auth_expired', 'Codex auth token expired');
  }

  let data: WhamUsageResponse;
  try {
    data = await httpGet<WhamUsageResponse>(
      'https://chatgpt.com/backend-api/wham/usage',
      {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'ChatGPT-Account-Id': accountId,
        Origin: 'https://chatgpt.com',
        Referer: 'https://chatgpt.com/',
        'User-Agent': 'Monitor/0.1.0',
      },
      auth.signal,
    );
  } catch (err) {
    if (err instanceof CodexRemoteQuotaError) throw err;
    throw new CodexRemoteQuotaError('network_error', 'Codex quota request failed');
  }

  const windows = extractRateLimitsFromRecord(data);
  if (!windows || windows.length === 0) {
    throw new CodexRemoteQuotaError('upstream_changed', 'Codex quota response changed');
  }

  return {
    provider: 'codex',
    capturedAt,
    source: 'remote_api',
    windows,
    providerAuthId: null,
    accountLabel: null,
    accountId: null,
    projectId: null,
    kind: 'quota',
    status: 'ok',
    rawPlanLabel: null,
    modelGroup: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

/**
 * Legacy local-wrapper for callers that predate ProviderAuth.
 * Reads credentials from `~/.codex/auth.json`.
 *
 * Returns null if auth file is missing, expired, or the request fails.
 */
export async function fetchRemoteQuota(): Promise<QuotaSnapshot | null> {
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');

  let authData: CodexAuthJson;
  try {
    const raw = await fs.promises.readFile(authPath, 'utf-8');
    authData = JSON.parse(raw) as CodexAuthJson;
  } catch {
    return null;
  }

  const accessToken = authData.tokens?.access_token;
  const accountId = authData.tokens?.account_id;

  if (!accessToken || !accountId) return null;

  try {
    return await fetchRemoteQuotaForAuth({ accessToken, accountId });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Combined quota fetcher
// ---------------------------------------------------------------------------

/**
 * Get the best available quota snapshot for Codex.
 * Prefers remote API (most accurate), falls back to local log parsing.
 */
export async function getCodexQuotaSnapshot(): Promise<QuotaSnapshot | null> {
  // Try remote first (more accurate, has real-time data)
  const remote = await fetchRemoteQuota();
  if (remote) return remote;

  // Fall back to local log parsing
  return parseLocalRateLimits();
}

// ---------------------------------------------------------------------------
// HTTP utility
// ---------------------------------------------------------------------------

function httpGet<T>(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    let req: http.ClientRequest;
    const abort = (): void => {
      req.destroy();
      fail(new CodexRemoteQuotaError('network_error', 'Codex quota request aborted'));
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort);
    };

    req = mod.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          fail(
            new CodexRemoteQuotaError(
              codexHttpStatusToErrorCode(res.statusCode ?? 0),
              `Codex quota returned HTTP ${res.statusCode ?? 0}`,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            succeed(JSON.parse(body) as T);
          } catch (e) {
            fail(new CodexRemoteQuotaError('upstream_changed', 'Codex quota response was not JSON'));
          }
        });
      },
    );

    req.on('error', () => {
      fail(new CodexRemoteQuotaError('network_error', 'Codex quota request failed'));
    });
    req.on('timeout', () => {
      req.destroy();
      fail(new CodexRemoteQuotaError('network_error', 'Codex quota request timeout'));
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// JWT expiry check
// ---------------------------------------------------------------------------

function codexHttpStatusToErrorCode(status: number): ProviderAuthErrorCode {
  if (status === 401 || status === 403) return 'upstream_unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'network_error';
  return 'upstream_changed';
}

function isJwtExpired(token: string, now = Date.now()): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  try {
    const payload = parts[1]!;
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8'));
    const exp = decoded?.exp;
    if (typeof exp !== 'number') return false; // Can't determine — assume valid
    return exp * 1000 <= now;
  } catch {
    return false; // Can't decode — assume valid and let the server reject
  }
}
