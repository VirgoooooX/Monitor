import * as http from 'node:http';
import * as https from 'node:https';

import type {
  ProviderAuthErrorCode,
  QuotaKind,
  QuotaSnapshot,
  QuotaWindow,
} from '../../../types';
import type { ProviderAuthRow } from '../../../store/repositories';

const MAX_ERROR_MESSAGE_LEN = 80;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const PROVIDER_AUTH_ERROR_CODES: ReadonlySet<ProviderAuthErrorCode> = new Set([
  'auth_missing',
  'auth_expired',
  'project_missing',
  'upstream_unauthorized',
  'rate_limited',
  'upstream_changed',
  'network_error',
  'unsupported',
  'parse_error',
  'unsupported_file',
  'cancelled',
  'validation',
]);

export class ProviderAdapterError extends Error {
  override readonly name = 'ProviderAdapterError';

  constructor(
    public readonly code: ProviderAuthErrorCode,
    message: string,
  ) {
    super(boundMessage(message));
  }
}

export function isProviderAuthErrorCode(
  code: unknown,
): code is ProviderAuthErrorCode {
  return typeof code === 'string' && PROVIDER_AUTH_ERROR_CODES.has(code as ProviderAuthErrorCode);
}

export function boundMessage(message: string): string {
  return message.length <= MAX_ERROR_MESSAGE_LEN
    ? message
    : message.slice(0, MAX_ERROR_MESSAGE_LEN);
}

export function unavailableSnapshot(
  account: ProviderAuthRow,
  capturedAt: number,
  code: ProviderAuthErrorCode,
  message: string,
  kind: QuotaKind = 'quota',
): QuotaSnapshot {
  return {
    provider: account.provider,
    capturedAt,
    source: 'imported_auth',
    windows: [],
    providerAuthId: account.id,
    accountLabel: account.label,
    accountId: account.accountId,
    projectId: account.projectId,
    kind,
    status: 'unavailable',
    rawPlanLabel: null,
    modelGroup: null,
    lastErrorCode: code,
    lastErrorMessage: boundMessage(message),
  };
}

export interface OkSnapshotOptions {
  readonly kind?: QuotaKind;
  readonly rawPlanLabel?: string | null;
  readonly modelGroup?: string | null;
}

export function okSnapshot(
  account: ProviderAuthRow,
  capturedAt: number,
  windows: QuotaWindow[],
  options: OkSnapshotOptions = {},
): QuotaSnapshot {
  return {
    provider: account.provider,
    capturedAt,
    source: 'imported_auth',
    windows,
    providerAuthId: account.id,
    accountLabel: account.label,
    accountId: account.accountId,
    projectId: account.projectId,
    kind: options.kind ?? 'quota',
    status: 'ok',
    rawPlanLabel: options.rawPlanLabel ?? null,
    modelGroup: options.modelGroup ?? null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

export function expiresAtHasPassed(
  expiresAt: unknown,
  now: number,
): boolean {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now;
}

export function jwtExpiresAtHasPassed(token: string, now: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = parts[1];
  if (payload === undefined) return false;
  try {
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8')) as {
      exp?: unknown;
    };
    return typeof decoded.exp === 'number' && decoded.exp * 1000 <= now;
  } catch {
    return false;
  }
}

export function httpStatusToErrorCode(status: number): ProviderAuthErrorCode {
  if (status === 401 || status === 403) return 'upstream_unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'network_error';
  return 'upstream_changed';
}

export interface RequestJsonInput {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type RequestJson = <T>(input: RequestJsonInput) => Promise<T>;

export const requestJson: RequestJson = async <T>(
  input: RequestJsonInput,
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const parsed = new URL(input.url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const method = input.method ?? 'GET';
    const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers: Record<string, string> = {
      ...(input.headers ?? {}),
    };

    if (bodyText !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyText).toString();
    }

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
      fail(new ProviderAdapterError('network_error', 'request aborted'));
    };
    const cleanup = (): void => {
      input.signal?.removeEventListener('abort', abort);
    };

    req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: input.timeoutMs ?? 15000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let total = 0;

        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy();
            fail(new ProviderAdapterError('upstream_changed', 'upstream response too large'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (status < 200 || status >= 300) {
            fail(
              new ProviderAdapterError(
                httpStatusToErrorCode(status),
                `upstream returned HTTP ${status}`,
              ),
            );
            return;
          }

          const text = Buffer.concat(chunks).toString('utf-8').trim();
          if (text.length === 0) {
            succeed({} as T);
            return;
          }
          try {
            succeed(JSON.parse(text) as T);
          } catch {
            fail(new ProviderAdapterError('upstream_changed', 'upstream response was not JSON'));
          }
        });
      },
    );

    req.on('error', (err) => {
      fail(
        err instanceof ProviderAdapterError
          ? err
          : new ProviderAdapterError('network_error', 'network request failed'),
      );
    });
    req.on('timeout', () => {
      req.destroy();
      fail(new ProviderAdapterError('network_error', 'request timeout'));
    });

    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.signal?.addEventListener('abort', abort, { once: true });

    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function normalisePercent(value: number | null): number | null {
  if (value === null) return null;
  if (value >= 0 && value <= 1) return Math.round(value * 10000) / 100;
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

export function getFirstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = asFiniteNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

export function getFirstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function getResetAt(record: Record<string, unknown>): number | null {
  const numeric = getFirstNumber(record, [
    'reset_time_ms',
    'resetTimeMs',
    'reset_at',
    'resetAt',
    'reset_time',
    'resetTime',
    'next_reset_time',
    'nextResetTime',
  ]);
  if (numeric !== null && numeric > 0) {
    return numeric > 1e11 ? Math.round(numeric) : Math.round(numeric * 1000);
  }

  const textual = getFirstString(record, [
    'reset_at',
    'resetAt',
    'reset_time',
    'resetTime',
    'next_reset_time',
    'nextResetTime',
  ]);
  if (textual !== null) {
    const parsed = Date.parse(textual);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

export function getWindowSeconds(record: Record<string, unknown>): number | null {
  const seconds = getFirstNumber(record, [
    'limit_window_seconds',
    'window_seconds',
    'windowSeconds',
    'duration_seconds',
    'durationSeconds',
  ]);
  return seconds === null || seconds <= 0 ? null : Math.round(seconds);
}

export function getPercentLeft(record: Record<string, unknown>): number | null {
  const explicit = getFirstNumber(record, [
    'percent_left',
    'percentLeft',
    'remaining_percent',
    'remainingPercent',
    'remaining_percentage',
    'remainingPercentage',
    'remainingFraction',
    'remaining_fraction',
  ]);
  if (explicit !== null) return normalisePercent(explicit);

  const usedPercent = getFirstNumber(record, [
    'used_percent',
    'usedPercent',
    'used_percentage',
    'usedPercentage',
    'usagePercent',
    'usage_percent',
  ]);
  if (usedPercent !== null) {
    const normalisedUsed = normalisePercent(usedPercent);
    return normalisedUsed === null ? null : Math.max(0, 100 - normalisedUsed);
  }

  const limit = getFirstNumber(record, ['limit', 'total', 'quota', 'quotaLimit']);
  const remaining = getFirstNumber(record, ['remaining', 'available', 'left', 'quotaRemaining']);
  if (limit !== null && limit > 0 && remaining !== null) {
    return normalisePercent((remaining / limit) * 100);
  }

  const used = getFirstNumber(record, ['used', 'consumed', 'usage']);
  if (limit !== null && limit > 0 && used !== null) {
    return normalisePercent(Math.max(0, ((limit - used) / limit) * 100));
  }

  return null;
}

export function windowFromRecord(
  name: string,
  value: unknown,
  fallbackWindowSeconds: number | null = null,
): QuotaWindow | null {
  const record = asRecord(value);
  if (record === null) return null;
  const percentLeft = getPercentLeft(record);
  const resetAt = getResetAt(record);
  const windowSeconds = getWindowSeconds(record) ?? fallbackWindowSeconds;
  if (percentLeft === null && resetAt === null && windowSeconds === null) return null;
  return {
    name,
    percentLeft,
    resetAt,
    windowSeconds,
  };
}

export function dedupeWindows(windows: readonly QuotaWindow[]): QuotaWindow[] {
  const out = new Map<string, QuotaWindow>();
  for (const window of windows) {
    const existing = out.get(window.name);
    if (existing === undefined) {
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
