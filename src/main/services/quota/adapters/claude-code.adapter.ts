import type { QuotaWindow } from '../../../types';
import {
  asRecord,
  expiresAtHasPassed,
  okSnapshot,
  ProviderAdapterError,
  requestJson,
  type RequestJson,
  unavailableSnapshot,
  windowFromRecord,
} from './common';
import type { ProviderAdapter } from './types';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const CLAUDE_WINDOWS: ReadonlyArray<{
  readonly key: string;
  readonly name: string;
  readonly seconds: number;
}> = [
  { key: 'five_hour', name: '5h', seconds: 5 * 60 * 60 },
  { key: 'seven_day', name: 'weekly', seconds: 7 * 24 * 60 * 60 },
  {
    key: 'seven_day_oauth_apps',
    name: 'weekly:oauth_apps',
    seconds: 7 * 24 * 60 * 60,
  },
  { key: 'seven_day_opus', name: 'weekly:opus', seconds: 7 * 24 * 60 * 60 },
  { key: 'seven_day_sonnet', name: 'weekly:sonnet', seconds: 7 * 24 * 60 * 60 },
  { key: 'seven_day_cowork', name: 'weekly:cowork', seconds: 7 * 24 * 60 * 60 },
];

export interface ClaudeCodeAdapterDeps {
  readonly requestJson?: RequestJson;
}

export function createClaudeCodeAdapter(
  deps: ClaudeCodeAdapterDeps = {},
): ProviderAdapter {
  const doRequest = deps.requestJson ?? requestJson;

  return {
    provider: 'claude-code',
    capability: 'official',
    async refresh({ account, getSecret, now, signal }) {
      const secret = getSecret();
      if (secret === null) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'Claude Code auth token is missing',
        );
      }

      const accessToken =
        typeof secret.accessToken === 'string' ? secret.accessToken.trim() : '';
      if (accessToken.length === 0) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'Claude Code auth token is missing',
        );
      }

      if (expiresAtHasPassed(secret.expiresAt, now)) {
        throw new ProviderAdapterError('auth_expired', 'Claude Code auth token expired');
      }

      const response = await doRequest<unknown>({
        url: CLAUDE_USAGE_URL,
        method: 'GET',
        ...(signal !== undefined ? { signal } : {}),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'Monitor/0.1.0',
        },
      });

      const windows = parseClaudeUsageWindows(response);
      if (windows.length === 0) {
        throw new ProviderAdapterError(
          'upstream_changed',
          'Claude usage response missing quota windows',
        );
      }
      return okSnapshot(account, now, windows);
    },
  };
}

export function parseClaudeUsageWindows(response: unknown): QuotaWindow[] {
  const root = asRecord(response);
  if (root === null) return [];

  const windows: QuotaWindow[] = [];
  for (const candidate of CLAUDE_WINDOWS) {
    const window = windowFromRecord(candidate.name, root[candidate.key], candidate.seconds);
    if (window !== null) windows.push(window);
  }
  return windows;
}

export const claudeCodeAdapter: ProviderAdapter = createClaudeCodeAdapter();
