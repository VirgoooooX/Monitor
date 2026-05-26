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

import type { QuotaSnapshot, QuotaWindow } from '../../types';

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
      };
    }
  }

  return null;
}

function extractRateLimitsFromRecord(record: unknown): QuotaWindow[] | null {
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

  // Try to extract 5h window
  const fiveHour = findWindow(obj, [
    'five_hour', 'five_hour_limit', 'five_hour_rate_limit',
    'primary', 'primary_window',
  ]);
  if (fiveHour) {
    windows.push({ name: '5h', ...fiveHour });
  }

  // Try to extract weekly window
  const weekly = findWindow(obj, [
    'weekly', 'weekly_limit', 'weekly_rate_limit',
    'secondary', 'secondary_window',
  ]);
  if (weekly) {
    windows.push({ name: 'weekly', ...weekly });
  }

  // If we only got one window, try to infer its type from window_seconds
  if (windows.length === 1 && windows[0]) {
    const ws = windows[0].windowSeconds;
    if (ws && ws >= 6 * 24 * 3600 && windows[0].name === '5h') {
      windows[0].name = 'weekly';
    }
  }

  return windows.length > 0 ? windows : null;
}

function findWindow(
  obj: Record<string, unknown>,
  keys: string[],
): Omit<QuotaWindow, 'name'> | null {
  for (const key of keys) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const w = val as Record<string, unknown>;
      const percentLeft = getPercentLeft(w);
      const resetAt = getResetAt(w);
      const windowSeconds = typeof w['limit_window_seconds'] === 'number'
        ? w['limit_window_seconds'] as number
        : null;

      if (percentLeft !== null || resetAt !== null) {
        return { percentLeft, resetAt, windowSeconds };
      }
    }
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

  // Check if token is expired (JWT decode)
  if (isJwtExpired(accessToken)) return null;

  try {
    const data = await httpGet<WhamUsageResponse>(
      'https://chatgpt.com/backend-api/wham/usage',
      {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'ChatGPT-Account-Id': accountId,
        Origin: 'https://chatgpt.com',
        Referer: 'https://chatgpt.com/',
        'User-Agent': 'Monitor/0.1.0',
      },
    );

    const rateLimitsObj = data.rate_limits ?? data.rate_limit;
    if (!rateLimitsObj) return null;

    const windows = extractRateLimitsFromRecord({ rate_limits: rateLimitsObj });
    if (!windows || windows.length === 0) return null;

    return {
      provider: 'codex',
      capturedAt: Date.now(),
      source: 'remote_api',
      windows,
    };
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

function httpGet<T>(url: string, headers: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const req = mod.get(
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
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ---------------------------------------------------------------------------
// JWT expiry check
// ---------------------------------------------------------------------------

function isJwtExpired(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return true;

  try {
    const payload = parts[1]!;
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8'));
    const exp = decoded?.exp;
    if (typeof exp !== 'number') return false; // Can't determine — assume valid
    return exp * 1000 <= Date.now();
  } catch {
    return false; // Can't decode — assume valid and let the server reject
  }
}
