import { describe, expect, it } from 'vitest';

import type { ProviderId, QuotaSnapshot } from '../../../types';
import type { ProviderAuthRow } from '../../../store/repositories';
import {
  ProviderAdapterError,
  type RequestJson,
  type RequestJsonInput,
} from './common';
import { createAntigravityAdapter } from './antigravity.adapter';
import { createClaudeCodeAdapter } from './claude-code.adapter';
import { createCodexAdapter } from './codex.adapter';
import { createDeepSeekAdapter } from './deepseek.adapter';
import { createGeminiCliAdapter } from './gemini-cli.adapter';
import { parseGoogleCodeAssistWindows } from './google-code-assist';

const NOW = 1_800_000_000_000;

function row(provider: ProviderId, patch: Partial<ProviderAuthRow> = {}): ProviderAuthRow {
  return {
    id: `${provider}-id`,
    provider,
    label: `${provider}:account`,
    source: 'cpa-auth-file',
    accountId: null,
    projectId: null,
    quotaCapability: 'official',
    importedAt: 1,
    updatedAt: 1,
    lastValidatedAt: 1,
    lastQuotaAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    enabled: true,
    secretKey: `cpaAuth.providerAuth.${provider}-id`,
    ...patch,
  };
}

function codexRemoteSnapshot(windows: QuotaSnapshot['windows']): QuotaSnapshot {
  return {
    provider: 'codex',
    capturedAt: NOW,
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

describe('official quota adapters — Codex', () => {
  it('uses imported ProviderAuth secret and returns imported_auth quota windows', async () => {
    const adapter = createCodexAdapter({
      fetchRemoteQuotaForAuth: async (input) => {
        expect(input.accessToken).toBe('codex-token');
        expect(input.accountId).toBe('codex-account');
        return codexRemoteSnapshot([
          {
            name: '5h',
            percentLeft: 55,
            resetAt: NOW + 1000,
            windowSeconds: 18_000,
          },
          {
            name: 'weekly',
            percentLeft: 80,
            resetAt: NOW + 2000,
            windowSeconds: 604_800,
          },
        ]);
      },
    });

    const snapshot = await adapter.refresh({
      account: row('codex', { accountId: 'codex-account' }),
      getSecret: () => ({ accessToken: 'codex-token', accountId: 'codex-account' }),
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      provider: 'codex',
      source: 'imported_auth',
      providerAuthId: 'codex-id',
      status: 'ok',
      kind: 'quota',
      lastErrorCode: null,
    });
    expect(snapshot.windows.map((window) => window.name)).toEqual(['5h', 'weekly']);
  });

  it('reports missing token/account id without reading local files', async () => {
    const adapter = createCodexAdapter({
      fetchRemoteQuotaForAuth: async () => {
        throw new Error('should not request');
      },
    });

    const snapshot = await adapter.refresh({
      account: row('codex'),
      getSecret: () => ({ accessToken: 'codex-token' }),
      now: NOW,
    });

    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('auth_missing');
  });

  it('throws auth_expired for expired JWTs', async () => {
    const expiredJwt = [
      'header',
      Buffer.from(JSON.stringify({ exp: Math.floor((NOW - 1000) / 1000) })).toString('base64url'),
      'sig',
    ].join('.');
    const adapter = createCodexAdapter();

    await expect(
      adapter.refresh({
        account: row('codex', { accountId: 'codex-account' }),
        getSecret: () => ({ accessToken: expiredJwt, accountId: 'codex-account' }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
  });
});

describe('official quota adapters — Claude Code', () => {
  it('parses five-hour and weekly usage windows', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      return {
        five_hour: { remaining_percent: 42, reset_time_ms: NOW + 1000 },
        seven_day: { used_percent: 10, reset_time_ms: NOW + 2000 },
      } as T;
    };
    const adapter = createClaudeCodeAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('claude-code'),
      getSecret: () => ({ accessToken: 'claude-token' }),
      now: NOW,
    });

    expect(calls[0]!.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(calls[0]!.headers?.['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(snapshot.windows).toMatchObject([
      { name: '5h', percentLeft: 42, windowSeconds: 18_000 },
      { name: 'weekly', percentLeft: 90, windowSeconds: 604_800 },
    ]);
  });

  it('preserves upstream auth failures as closed adapter errors', async () => {
    const adapter = createClaudeCodeAdapter({
      requestJson: async () => {
        throw new ProviderAdapterError('upstream_unauthorized', 'upstream returned HTTP 401');
      },
    });

    await expect(
      adapter.refresh({
        account: row('claude-code'),
        getSecret: () => ({ accessToken: 'claude-token' }),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'upstream_unauthorized' });
  });
});

describe('official quota adapters — Gemini CLI', () => {
  it('requires a project id before calling Cloud Code', async () => {
    const adapter = createGeminiCliAdapter({
      requestJson: async () => {
        throw new Error('should not request');
      },
    });

    const snapshot = await adapter.refresh({
      account: row('gemini-cli'),
      getSecret: () => ({ accessToken: 'google-token' }),
      now: NOW,
    });

    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('project_missing');
  });

  it('calls retrieveUserQuota and loadCodeAssist using ProviderAuth credentials', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      if (input.url.endsWith(':retrieveUserQuota')) {
        return {
          buckets: [
            {
              modelId: 'gemini-2.5-pro',
              tokenType: 'input',
              limit: 100,
              remaining: 25,
              resetTime: new Date(NOW + 3000).toISOString(),
            },
          ],
        } as T;
      }
      return {} as T;
    };
    const adapter = createGeminiCliAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('gemini-cli', { projectId: 'project-1' }),
      getSecret: () => ({ accessToken: 'google-token', projectId: 'project-1' }),
      now: NOW,
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    ]);
    expect(calls[0]!.body).toMatchObject({
      project: 'project-1',
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain('userAgent');
    expect(calls[1]!.body).toMatchObject({
      cloudaicompanionProject: 'project-1',
      metadata: { ideType: 'GEMINI_CLI' },
    });
    expect(snapshot.windows).toMatchObject([
      {
        name: 'Gemini Pro',
        percentLeft: 25,
      },
    ]);
  });

  it('refreshes expired Google access tokens before querying quota', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      if (input.url === 'https://oauth2.googleapis.com/token') {
        expect(input.body).toBeInstanceOf(URLSearchParams);
        expect(String(input.body)).toContain('grant_type=refresh_token');
        return { access_token: 'fresh-google-token', expires_in: 3600 } as T;
      }
      expect(input.headers?.Authorization).toBe('Bearer fresh-google-token');
      if (input.url.endsWith(':retrieveUserQuota')) {
        return {
          buckets: [{
            modelId: 'gemini-2.5-flash',
            limit: 100,
            remaining: 50,
          }],
        } as T;
      }
      return {} as T;
    };
    const adapter = createGeminiCliAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('gemini-cli', { projectId: 'project-1' }),
      getSecret: () => ({
        accessToken: 'expired-google-token',
        refreshToken: 'google-refresh-token',
        projectId: 'project-1',
        expiresAt: NOW - 1000,
      }),
      now: NOW,
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    ]);
    expect(snapshot.windows).toMatchObject([
      { name: 'Gemini Flash', percentLeft: 50 },
    ]);
  });

  it('refreshes and retries once when Google rejects the imported access token', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      if (input.url === 'https://oauth2.googleapis.com/token') {
        return { access_token: 'fresh-google-token' } as T;
      }
      if (input.headers?.Authorization === 'Bearer stale-google-token') {
        throw new ProviderAdapterError('upstream_unauthorized', 'upstream returned HTTP 401');
      }
      if (input.url.endsWith(':retrieveUserQuota')) {
        return {
          buckets: [{
            modelId: 'gemini-2.5-flash-lite',
            limit: 100,
            remaining: 75,
          }],
        } as T;
      }
      return {} as T;
    };
    const adapter = createGeminiCliAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('gemini-cli', { projectId: 'project-1' }),
      getSecret: () => ({
        accessToken: 'stale-google-token',
        refreshToken: 'google-refresh-token',
        projectId: 'project-1',
      }),
      now: NOW,
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      'https://oauth2.googleapis.com/token',
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    ]);
    expect(snapshot.windows).toMatchObject([
      { name: 'Gemini Flash', percentLeft: 75 },
    ]);
  });

  it('normalises Gemini CLI model buckets to CPA-style names', () => {
    const windows = parseGoogleCodeAssistWindows(
      {
        buckets: [
          {
            modelId: 'gemini-2.5-flash-lite',
            tokenType: 'input',
            limit: 100,
            remaining: 100,
            resetTime: new Date(NOW + 1000).toISOString(),
          },
          {
            modelId: 'gemini-2.5-flash',
            tokenType: 'output',
            limit: 100,
            remaining: 99,
            resetTime: new Date(NOW + 2000).toISOString(),
          },
          {
            modelId: 'gemini-2.5-pro',
            tokenType: 'input',
            limit: 100,
            remaining: 98,
            resetTime: new Date(NOW + 3000).toISOString(),
          },
          {
            modelId: 'gemini-3.1-flash-lite-preview',
            limit: 100,
            remaining: 97,
            resetTime: new Date(NOW + 4000).toISOString(),
          },
        ],
      },
      'gemini-cli',
    );

    expect(windows.map((window) => window.name)).toEqual([
      'Gemini Pro',
      'Gemini Flash',
    ]);
  });
});

describe('official quota adapters — Antigravity', () => {
  it('uses the Antigravity OAuth client when refreshing Antigravity tokens', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      if (input.url === 'https://oauth2.googleapis.com/token') {
        expect(String(input.body)).toContain(
          'client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
        );
        return { access_token: 'fresh-antigravity-token' } as T;
      }
      expect(input.headers?.Authorization).toBe('Bearer fresh-antigravity-token');
      if (input.url.endsWith(':fetchAvailableModels')) {
        return {
          models: {
            'gemini-3.1-pro-high': {
              displayName: 'Gemini 3.1 Pro High',
              quotaInfo: { remainingFraction: 0.6 },
            },
          },
        } as T;
      }
      return {} as T;
    };
    const adapter = createAntigravityAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('antigravity', { projectId: 'project-ag' }),
      getSecret: () => ({
        accessToken: 'expired-antigravity-token',
        refreshToken: 'antigravity-refresh-token',
        projectId: 'project-ag',
        expiresAt: NOW - 1000,
      }),
      now: NOW,
    });

    expect(calls.map((call) => call.url).slice(0, 3)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    ]);
    expect(snapshot.windows).toMatchObject([
      { name: 'Gemini', percentLeft: 60 },
    ]);
  });

  it('falls back across Antigravity bases and parses Code Assist windows', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      if (input.url.startsWith('https://daily-cloudcode-pa.googleapis.com')) {
        throw new ProviderAdapterError('network_error', 'daily endpoint unavailable');
      }
      if (input.url.endsWith(':loadCodeAssist')) {
        return {
          models: {
            'antigravity-pro': {
              displayName: 'Antigravity Pro',
              quotaInfo: {
                remainingFraction: 0.8,
                resetTime: new Date(NOW + 4000).toISOString(),
              },
            },
          },
        } as T;
      }
      return {} as T;
    };
    const adapter = createAntigravityAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('antigravity', { projectId: 'project-ag' }),
      getSecret: () => ({ accessToken: 'google-token', projectId: 'project-ag' }),
      now: NOW,
    });

    expect(calls.some((call) =>
      call.url.startsWith('https://daily-cloudcode-pa.sandbox.googleapis.com'),
    )).toBe(true);
    expect(calls.some((call) =>
      call.url.endsWith(':fetchAvailableModels') &&
      JSON.stringify(call.body).includes('"project":"project-ag"'),
    )).toBe(true);
    expect(calls.some((call) =>
      call.url.endsWith(':loadCodeAssist') &&
      JSON.stringify(call.body).includes('"cloudaicompanionProject":"project-ag"'),
    )).toBe(true);
    const loadCall = calls.find((call) =>
      call.url.endsWith(':loadCodeAssist') &&
      call.url.startsWith('https://daily-cloudcode-pa.sandbox.googleapis.com'),
    );
    expect(loadCall?.body).toMatchObject({
      cloudaicompanionProject: 'project-ag',
      metadata: { ideType: 'ANTIGRAVITY' },
    });
    expect(snapshot.windows).toMatchObject([
      { name: 'Antigravity Pro', percentLeft: 80 },
    ]);
  });

  it('filters internal Antigravity placeholders and keeps CPA-visible buckets', () => {
    const windows = parseGoogleCodeAssistWindows(
      {
        models: {
          MODEL_PLACEHOLDER_M26: {
            quotaInfo: { remainingFraction: 1, resetTime: new Date(NOW + 1000).toISOString() },
          },
          MODEL_OPENAI_GPT_OSS_120B_MEDIUM: {
            quotaInfo: { remainingFraction: 1, resetTime: new Date(NOW + 1000).toISOString() },
          },
          MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING: {
            quotaInfo: { remainingFraction: 1, resetTime: new Date(NOW + 1000).toISOString() },
          },
          MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE: {
            quotaInfo: { remainingFraction: 1, resetTime: new Date(NOW + 1000).toISOString() },
          },
          MODEL_GOOGLE_GEMINI_2_5_PRO: {
            quotaInfo: { remainingFraction: 0.99, resetTime: new Date(NOW + 2000).toISOString() },
          },
          MODEL_CHAT_20706: {
            quotaInfo: { remainingFraction: 1, resetTime: new Date(NOW + 3000).toISOString() },
          },
          MODEL_CHAT_23310: {
            quotaInfo: { remainingFraction: 1, resetTime: new Date(NOW + 4000).toISOString() },
          },
        },
      },
      'antigravity',
    );

    expect(windows.map((window) => window.name)).toEqual([
      'Gemini',
    ]);
    expect(windows.some((window) => window.name.includes('PLACEHOLDER'))).toBe(false);
    expect(windows.some((window) => window.name.includes('Claude'))).toBe(false);
    expect(windows.some((window) => window.name.includes('GPT'))).toBe(false);
  });
});

describe('official quota adapters — DeepSeek', () => {
  it('calls the official balance endpoint and emits credits windows', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      return {
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '110.00',
            granted_balance: '10.00',
            topped_up_balance: '100.00',
          },
        ],
      } as T;
    };
    const adapter = createDeepSeekAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('deepseek'),
      getSecret: () => ({ apiKey: 'sk-deepseek' }),
      now: NOW,
    });

    expect(calls[0]).toMatchObject({
      url: 'https://api.deepseek.com/user/balance',
      method: 'GET',
    });
    expect(calls[0]!.headers?.Authorization).toBe('Bearer sk-deepseek');
    expect(snapshot).toMatchObject({
      provider: 'deepseek',
      status: 'ok',
      kind: 'credits',
      rawPlanLabel: 'CNY 总额 110.00 / 赠金 10.00 / 充值 100.00',
    });
    expect(snapshot.windows).toMatchObject([
      {
        name: 'credits:CNY 总额 110.00 / 赠金 10.00 / 充值 100.00',
        percentLeft: 100,
      },
    ]);
  });
});
