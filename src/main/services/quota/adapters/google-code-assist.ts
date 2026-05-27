import type { ProviderId, QuotaKind, QuotaWindow } from '../../../types';
import {
  asFiniteNumber,
  asRecord,
  dedupeWindows,
  getFirstString,
  isProviderAuthErrorCode,
  okSnapshot,
  ProviderAdapterError,
  requestJson,
  type RequestJson,
  unavailableSnapshot,
  windowFromRecord,
} from './common';
import type { ProviderAdapter } from './types';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_OAUTH_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GOOGLE_OAUTH_CLIENT_SECRET = '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';
const ANTIGRAVITY_OAUTH_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_OAUTH_CLIENT_SECRET = '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';
const TOKEN_EXPIRY_SKEW_MS = 60_000;

type CodeAssistAction =
  | 'retrieveUserQuota'
  | 'loadCodeAssist'
  | 'fetchAvailableModels';

export interface GoogleCodeAssistAdapterConfig {
  readonly provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>;
  readonly bases: readonly string[];
  readonly ideType: string;
  readonly userAgent: string;
  readonly xGoogApiClient?: string;
  readonly actions: readonly CodeAssistAction[];
}

export interface GoogleCodeAssistAdapterDeps {
  readonly requestJson?: RequestJson;
}

interface GoogleRefreshTokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
}

export function createGoogleCodeAssistAdapter(
  config: GoogleCodeAssistAdapterConfig,
  deps: GoogleCodeAssistAdapterDeps = {},
): ProviderAdapter {
  const doRequest = deps.requestJson ?? requestJson;

  return {
    provider: config.provider,
    capability: 'official',
    async refresh({ account, getSecret, now, signal }) {
      const secret = getSecret();
      if (secret === null) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          `${config.provider} auth token is missing`,
        );
      }

      const accessToken =
        typeof secret.accessToken === 'string' ? secret.accessToken.trim() : '';
      const projectId =
        typeof secret.projectId === 'string'
          ? secret.projectId.trim()
          : (account.projectId ?? '').trim();

      if (accessToken.length === 0) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          `${config.provider} auth token is missing`,
        );
      }
      if (projectId.length === 0) {
        return unavailableSnapshot(
          account,
          now,
          'project_missing',
          `${config.provider} project id is missing`,
        );
      }

      let requestAccessToken = accessToken;
      if (googleAccessTokenShouldRefresh(secret.expiresAt, now)) {
        requestAccessToken = await refreshGoogleAccessToken(
          secret,
          config.provider,
          doRequest,
          signal,
        );
      }

      let lastError: ProviderAdapterError | null = null;
      for (const base of config.bases) {
        const responses: unknown[] = [];
        try {
          responses.push(
            ...(await requestCodeAssistActions({
              base,
              actions: config.actions,
              projectId,
              config,
              accessToken: requestAccessToken,
              doRequest,
              ...(signal !== undefined ? { signal } : {}),
            })),
          );

          const windows = parseGoogleCodeAssistWindows(responses, config.provider);
          if (windows.length === 0) {
            throw new ProviderAdapterError(
              'upstream_changed',
              `${config.provider} quota response missing windows`,
            );
          }

          return okSnapshot(account, now, windows, {
            kind: inferKind(windows),
          });
        } catch (err) {
          const coded = normaliseError(err, `${config.provider} quota request failed`);
          lastError = coded;
          if (
            coded.code === 'upstream_unauthorized' &&
            requestAccessToken === accessToken &&
            typeof secret.refreshToken === 'string' &&
            secret.refreshToken.trim().length > 0
          ) {
            try {
              requestAccessToken = await refreshGoogleAccessToken(
                secret,
                config.provider,
                doRequest,
                signal,
              );
              const retryInput = {
                base,
                actions: config.actions,
                projectId,
                config,
                accessToken: requestAccessToken,
                doRequest,
                ...(signal !== undefined ? { signal } : {}),
              };
              const retriedResponses = await requestCodeAssistActions({
                ...retryInput,
              });
              const windows = parseGoogleCodeAssistWindows(retriedResponses, config.provider);
              if (windows.length === 0) {
                throw new ProviderAdapterError(
                  'upstream_changed',
                  `${config.provider} quota response missing windows`,
                );
              }
              return okSnapshot(account, now, windows, {
                kind: inferKind(windows),
              });
            } catch (refreshErr) {
              lastError = normaliseError(refreshErr, `${config.provider} auth token refresh failed`);
              throw lastError;
            }
          }
          if (
            coded.code === 'upstream_unauthorized' ||
            coded.code === 'rate_limited' ||
            coded.code === 'auth_expired'
          ) {
            throw coded;
          }
        }
      }

      throw lastError ?? new ProviderAdapterError('network_error', `${config.provider} quota request failed`);
    },
  };
}

async function requestCodeAssistActions(input: {
  readonly base: string;
  readonly actions: readonly CodeAssistAction[];
  readonly projectId: string;
  readonly config: GoogleCodeAssistAdapterConfig;
  readonly accessToken: string;
  readonly signal?: AbortSignal;
  readonly doRequest: RequestJson;
}): Promise<unknown[]> {
  const responses: unknown[] = [];
  for (const action of input.actions) {
    try {
      responses.push(
        await input.doRequest<unknown>({
          url: `${input.base.replace(/\/$/, '')}/v1internal:${action}`,
          method: 'POST',
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            Accept: 'application/json',
            'User-Agent': input.config.userAgent,
            ...(input.config.xGoogApiClient !== undefined
              ? { 'X-Goog-Api-Client': input.config.xGoogApiClient }
              : {}),
          },
          body: bodyForAction(action, input.projectId, input.config),
        }),
      );
    } catch (err) {
      const coded = normaliseError(err, `${input.config.provider} quota request failed`);
      if (
        coded.code === 'upstream_unauthorized' ||
        coded.code === 'rate_limited' ||
        coded.code === 'auth_expired'
      ) {
        throw coded;
      }
    }
  }
  return responses;
}

function googleAccessTokenShouldRefresh(
  expiresAt: number | undefined,
  now: number,
): boolean {
  return typeof expiresAt === 'number' &&
    Number.isFinite(expiresAt) &&
    expiresAt <= now + TOKEN_EXPIRY_SKEW_MS;
}

async function refreshGoogleAccessToken(
  secret: { readonly refreshToken?: string },
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>,
  doRequest: RequestJson,
  signal: AbortSignal | undefined,
): Promise<string> {
  const refreshToken =
    typeof secret.refreshToken === 'string' ? secret.refreshToken.trim() : '';
  if (refreshToken.length === 0) {
    throw new ProviderAdapterError('auth_expired', 'Google auth token expired');
  }
  const oauthClient = googleOauthClientForProvider(provider);

  let response: GoogleRefreshTokenResponse;
  try {
    response = await doRequest<GoogleRefreshTokenResponse>({
      url: GOOGLE_OAUTH_TOKEN_URL,
      method: 'POST',
      ...(signal !== undefined ? { signal } : {}),
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: oauthClient.clientId,
        client_secret: oauthClient.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (err) {
    const coded = normaliseError(err, 'Google auth token refresh failed');
    if (
      coded.code === 'upstream_unauthorized' ||
      coded.code === 'upstream_changed'
    ) {
      throw new ProviderAdapterError('auth_expired', 'Google refresh token rejected');
    }
    throw coded;
  }

  const nextToken =
    typeof response.access_token === 'string' ? response.access_token.trim() : '';
  if (nextToken.length === 0) {
    throw new ProviderAdapterError('auth_expired', 'Google refresh token rejected');
  }
  return nextToken;
}

function googleOauthClientForProvider(
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>,
): { readonly clientId: string; readonly clientSecret: string } {
  return provider === 'antigravity'
    ? {
        clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
        clientSecret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
      }
    : {
        clientId: GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
      };
}

function bodyForAction(
  action: CodeAssistAction,
  projectId: string,
  config: GoogleCodeAssistAdapterConfig,
): Record<string, unknown> {
  switch (action) {
    case 'retrieveUserQuota':
      return { project: projectId };
    case 'fetchAvailableModels':
      return { project: projectId };
    case 'loadCodeAssist':
      return {
        cloudaicompanionProject: projectId,
        metadata: {
          ideType: config.ideType,
        },
      };
  }
}

export function parseGoogleCodeAssistWindows(
  response: unknown,
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'> = 'gemini-cli',
): QuotaWindow[] {
  const roots = Array.isArray(response) ? response : [response];
  const windows: QuotaWindow[] = [];

  for (let i = 0; i < roots.length; i += 1) {
    appendWindowsFromValue(windows, roots[i], `response:${i + 1}`, null);
  }

  return normaliseGoogleWindows(dedupeWindows(windows), provider);
}

function appendWindowsFromValue(
  windows: QuotaWindow[],
  value: unknown,
  path: string,
  inheritedLabel: string | null,
): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      appendWindowsFromValue(windows, value[i], `${path}:${i + 1}`, inheritedLabel);
    }
    return;
  }

  const record = asRecord(value);
  if (record === null) return;

  const ownLabel = labelForRecord(record) ?? inheritedLabel ?? lastPathSegment(path);
  const quotaInfo = record['quotaInfo'];
  if (quotaInfo !== undefined) {
    const quotaWindow = windowFromRecord(ownLabel, quotaInfo, inferWindowSeconds(ownLabel));
    if (quotaWindow !== null) {
      windows.push(quotaWindow);
    } else {
      appendWindowsFromValue(windows, quotaInfo, `${path}:quotaInfo`, ownLabel);
    }
  } else {
    const window = windowFromRecord(ownLabel, record, inferWindowSeconds(ownLabel));
    if (window !== null) {
      windows.push(window);
    }
  }

  const availableCredits = asRecord(record['availableCredits']);
  if (availableCredits !== null) {
    for (const [creditName, creditValue] of Object.entries(availableCredits)) {
      const amount = asFiniteNumber(creditValue);
      const suffix = amount === null ? '' : ` (${amount})`;
      windows.push({
        name: `credits:${creditName}${suffix}`,
        percentLeft: null,
        resetAt: null,
        windowSeconds: null,
      });
    }
  }

  for (const [key, child] of Object.entries(record)) {
    if (key === 'availableCredits' || key === 'quotaInfo') continue;
    appendWindowsFromValue(
      windows,
      child,
      `${path}:${key}`,
      inheritedLabelForChild(key, child, ownLabel),
    );
  }
}

function inheritedLabelForChild(
  key: string,
  child: unknown,
  ownLabel: string,
): string {
  if (key === 'buckets' || key === 'models') return ownLabel;
  if (key === 'quotaInfo') return ownLabel;
  if (Array.isArray(child)) return ownLabel;
  const record = asRecord(child);
  if (record === null) return ownLabel;
  return labelForRecord(record) ?? key;
}

function labelForRecord(record: Record<string, unknown>): string | null {
  const displayName = getFirstString(record, [
    'displayName',
    'display_name',
  ]);
  if (displayName !== null) return displayName;

  const model = getFirstString(record, [
    'modelId',
    'model_id',
    'model',
    'modelName',
    'model_name',
  ]);
  const tokenType = getFirstString(record, [
    'tokenType',
    'token_type',
    'bucket',
    'bucketId',
    'bucket_id',
  ]);
  const named = getFirstString(record, [
    'name',
    'id',
    'limitName',
    'limit_name',
    'quotaName',
    'quota_name',
  ]);

  const parts = [model, tokenType].filter((part): part is string => part !== null);
  if (parts.length > 0) return parts.join(':');
  return named;
}

function lastPathSegment(path: string): string {
  const parts = path.split(':');
  return parts[parts.length - 1] ?? path;
}

function inferWindowSeconds(name: string): number | null {
  const lower = name.toLowerCase();
  if (lower.includes('five') || lower.includes('5h')) return 5 * 60 * 60;
  if (lower.includes('seven') || lower.includes('weekly') || lower.includes('7d')) {
    return 7 * 24 * 60 * 60;
  }
  if (lower.includes('daily') || lower.includes('24h')) return 24 * 60 * 60;
  return null;
}

function normaliseGoogleWindows(
  windows: readonly QuotaWindow[],
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>,
): QuotaWindow[] {
  // Both Antigravity and Gemini CLI now collapse multiple raw model
  // buckets into a small set of display groups (Antigravity:
  // Claude/Gemini; Gemini CLI: Gemini Pro/Flash). Within a group we
  // average percentLeft so the visible bar reflects the group as a
  // whole rather than its worst member.
  type Aggregator = {
    name: string;
    percentSum: number;
    percentCount: number;
    resetAt: number | null;
    windowSeconds: number | null;
  };
  const byName = new Map<string, Aggregator>();

  for (const window of windows) {
    const name = normaliseGoogleQuotaName(window.name, provider);
    if (name === null) continue;

    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, {
        name,
        percentSum: window.percentLeft ?? 0,
        percentCount: window.percentLeft === null ? 0 : 1,
        resetAt: window.resetAt,
        windowSeconds: window.windowSeconds ?? inferWindowSeconds(name),
      });
      continue;
    }

    if (window.percentLeft !== null) {
      existing.percentSum += window.percentLeft;
      existing.percentCount += 1;
    }
    existing.resetAt = minNullable(existing.resetAt, window.resetAt);
    existing.windowSeconds = existing.windowSeconds ?? window.windowSeconds ?? inferWindowSeconds(name);
  }

  const merged: QuotaWindow[] = [];
  byName.forEach((agg) => {
    const percentLeft = agg.percentCount === 0 ? null : agg.percentSum / agg.percentCount;
    merged.push({
      name: agg.name,
      percentLeft,
      resetAt: agg.resetAt,
      windowSeconds: agg.windowSeconds,
    });
  });

  return merged.sort(
    (a, b) => googleWindowPriority(a.name, provider) - googleWindowPriority(b.name, provider),
  );
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function normaliseGoogleQuotaName(
  name: string,
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('credits:')) return trimmed;

  const base = trimmed.split(':')[0]?.trim() ?? trimmed;
  const upper = base.toUpperCase();
  const lower = base.toLowerCase();

  if (/^MODEL_PLACEHOLDER_M\d+$/.test(upper)) return null;
  if (/^MODEL_CHAT_\d+$/.test(upper)) return normaliseKnownChatModel(upper, provider);
  if (/^MODEL_[A-Z0-9_]+$/.test(upper)) {
    return normaliseEnumModel(upper, provider);
  }

  if (provider === 'antigravity') {
    if (lower.includes('claude') || lower.includes('anthropic')) return 'Claude';
    if (lower.includes('gpt') || lower.includes('openai')) return null;
    if (lower.includes('image')) return null;
    if (lower.includes('gemini') || lower.includes('google')) return 'Gemini';
    if (/^response:\d+$/.test(trimmed) || /^\d+$/.test(trimmed)) return null;
    // Antigravity displayName fallback (e.g. "Antigravity Pro" CPA bucket).
    return trimmed;
  }

  // Gemini CLI rules: Google CPA exposes a per-modelId daily bucket. We
  // collapse all Pro variants into one row and all Flash variants
  // (including Flash Lite + previews) into another so the strip stays
  // readable as new model variants ship. Within each row we keep the
  // existing min-merge behaviour (most-pessimistic).
  if (lower.includes('gemini') || lower.includes('google')) {
    if (lower.includes('image')) return null;
    if (lower.includes('pro')) return 'Gemini Pro';
    if (lower.includes('flash')) return 'Gemini Flash';
  }

  if (/^response:\d+$/.test(trimmed) || /^\d+$/.test(trimmed)) return null;
  return trimmed;
}

function normaliseKnownChatModel(
  name: string,
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>,
): string | null {
  if (provider === 'antigravity') {
    // MODEL_CHAT_23310 is Gemini 3.1 Flash Image — filtered out (separate pool, rarely used).
    if (name === 'MODEL_CHAT_23310') return null;
    // Other MODEL_CHAT_* are Gemini variants → fold into one bucket.
    return 'Gemini';
  }
  switch (name) {
    case 'MODEL_CHAT_20706': return 'Gemini 3 Flash';
    case 'MODEL_CHAT_23310': return 'Gemini 3.1 Flash Image';
    default: return null;
  }
}

function normaliseEnumModel(
  name: string,
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>,
): string | null {
  if (provider === 'antigravity') {
    if (name.includes('CLAUDE') || name.includes('ANTHROPIC')) return 'Claude';
    if (name.includes('OPENAI') || name.includes('GPT')) return null;
    if (name.includes('IMAGE')) return null;
    if (name.includes('GEMINI') || name.includes('GOOGLE')) return 'Gemini';
    return null;
  }

  if (
    name.includes('OPENAI') ||
    name.includes('GPT') ||
    name.includes('ANTHROPIC') ||
    name.includes('CLAUDE')
  ) {
    return 'Claude/GPT';
  }
  if (name.includes('IMAGE')) return null;
  if (name.includes('GEMINI') || name.includes('GOOGLE')) {
    if (name.includes('PRO')) return 'Gemini Pro';
    if (name.includes('FLASH')) return 'Gemini Flash';
  }
  return null;
}

function googleWindowPriority(
  name: string,
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>,
): number {
  const antigravityOrder = [
    'Claude',
    'Gemini',
  ];
  const geminiCliOrder = [
    'Gemini Pro',
    'Gemini Flash',
  ];
  const order = provider === 'antigravity' ? antigravityOrder : geminiCliOrder;
  const index = order.indexOf(name);
  return index === -1 ? 100 : index;
}

function inferKind(windows: readonly QuotaWindow[]): QuotaKind {
  return windows.every((window) => window.name.startsWith('credits:'))
    ? 'credits'
    : 'quota';
}

function normaliseError(err: unknown, fallback: string): ProviderAdapterError {
  if (err instanceof ProviderAdapterError) return err;
  if (
    err !== null &&
    typeof err === 'object' &&
    isProviderAuthErrorCode((err as { code?: unknown }).code)
  ) {
    const message = (err as { message?: unknown }).message;
    return new ProviderAdapterError(
      (err as { code: ProviderAdapterError['code'] }).code,
      typeof message === 'string' ? message : fallback,
    );
  }
  return new ProviderAdapterError('network_error', fallback);
}
