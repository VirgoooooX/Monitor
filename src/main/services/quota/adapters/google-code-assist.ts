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
      let lastError: ProviderAdapterError | null = null;
      for (const base of config.bases) {
        const responses: unknown[] = [];
        try {
          for (const action of config.actions) {
            try {
            responses.push(
              await doRequest<unknown>({
                url: `${base.replace(/\/$/, '')}/v1internal:${action}`,
                method: 'POST',
                ...(signal !== undefined ? { signal } : {}),
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: 'application/json',
                  'User-Agent': config.userAgent,
                  ...(config.xGoogApiClient !== undefined
                    ? { 'X-Goog-Api-Client': config.xGoogApiClient }
                    : {}),
                },
                body: bodyForAction(action, projectId, config),
              }),
            );
            } catch (err) {
              const coded = normaliseError(err, `${config.provider} quota request failed`);
              lastError = coded;
              if (
                coded.code === 'upstream_unauthorized' ||
                coded.code === 'rate_limited' ||
                coded.code === 'auth_expired'
              ) {
                throw coded;
              }
            }
          }

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

function bodyForAction(
  action: CodeAssistAction,
  projectId: string,
  config: GoogleCodeAssistAdapterConfig,
): Record<string, unknown> {
  switch (action) {
    case 'retrieveUserQuota':
      return { project: projectId, userAgent: config.userAgent };
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
  const byName = new Map<string, QuotaWindow>();

  for (const window of windows) {
    const name = normaliseGoogleQuotaName(window.name, provider);
    if (name === null) continue;

    const next: QuotaWindow = {
      ...window,
      name,
      windowSeconds: window.windowSeconds ?? inferWindowSeconds(name),
    };
    const existing = byName.get(name);
    byName.set(name, existing === undefined ? next : mergeWindow(existing, next));
  }

  return [...byName.values()].sort(
    (a, b) => googleWindowPriority(a.name, provider) - googleWindowPriority(b.name, provider),
  );
}

function mergeWindow(a: QuotaWindow, b: QuotaWindow): QuotaWindow {
  return {
    name: a.name,
    percentLeft: minNullable(a.percentLeft, b.percentLeft),
    resetAt: minNullable(a.resetAt, b.resetAt),
    windowSeconds: a.windowSeconds ?? b.windowSeconds,
  };
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
  if (/^MODEL_CHAT_\d+$/.test(upper)) return normaliseKnownChatModel(upper);
  if (/^MODEL_[A-Z0-9_]+$/.test(upper)) {
    return normaliseEnumModel(upper, provider);
  }

  if (lower.includes('gemini-2.5-flash-lite')) {
    return provider === 'antigravity' ? 'Gemini 2.5 Flash Lite' : 'Gemini Flash Lite Series';
  }
  if (lower.includes('gemini-2.5-flash')) {
    return provider === 'antigravity' ? 'Gemini 2.5 Flash' : 'Gemini Flash Series';
  }
  if (lower.includes('gemini-2.5-pro')) {
    return provider === 'antigravity' ? 'Gemini 3.1 Pro Series' : 'Gemini Pro Series';
  }
  if (lower.includes('gemini-3.1-flash-lite-preview')) return 'gemini-3.1-flash-lite-preview';
  if (lower.includes('gemini-3.1-flash-lite')) return 'gemini-3.1-flash-lite';
  if (lower.includes('gemini-3.1-pro')) return 'Gemini 3.1 Pro Series';
  if (lower.includes('gemini-3-flash')) return 'Gemini 3 Flash';

  if (/^response:\d+$/.test(trimmed) || /^\d+$/.test(trimmed)) return null;
  return trimmed;
}

function normaliseKnownChatModel(name: string): string | null {
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
  if (
    name.includes('OPENAI') ||
    name.includes('GPT') ||
    name.includes('ANTHROPIC') ||
    name.includes('CLAUDE')
  ) {
    return 'Claude/GPT';
  }
  if (name.includes('GOOGLE_GEMINI_3_1_FLASH_IMAGE')) return 'Gemini 3.1 Flash Image';
  if (name.includes('GOOGLE_GEMINI_3_1_PRO')) return 'Gemini 3.1 Pro Series';
  if (name.includes('GOOGLE_GEMINI_3_FLASH')) return 'Gemini 3 Flash';
  if (name.includes('GOOGLE_GEMINI_2_5_FLASH_LITE')) {
    return provider === 'antigravity' ? 'Gemini 2.5 Flash Lite' : 'Gemini Flash Lite Series';
  }
  if (name.includes('GOOGLE_GEMINI_2_5_FLASH')) {
    return provider === 'antigravity' ? 'Gemini 2.5 Flash' : 'Gemini Flash Series';
  }
  if (name.includes('GOOGLE_GEMINI_2_5_PRO')) {
    return provider === 'antigravity' ? 'Gemini 3.1 Pro Series' : 'Gemini Pro Series';
  }
  return null;
}

function googleWindowPriority(
  name: string,
  provider: Extract<ProviderId, 'gemini-cli' | 'antigravity'>,
): number {
  const antigravityOrder = [
    'Claude/GPT',
    'Gemini 3.1 Pro Series',
    'Gemini 2.5 Flash',
    'Gemini 2.5 Flash Lite',
    'Gemini 3 Flash',
    'Gemini 3.1 Flash Image',
  ];
  const geminiCliOrder = [
    'Gemini Flash Lite Series',
    'Gemini Flash Series',
    'Gemini Pro Series',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview',
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
