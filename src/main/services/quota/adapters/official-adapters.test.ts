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

  it('prefers the console path when a userToken is configured (multi-wallet + daily usage)', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      if (input.url.includes('/api/v0/users/get_user_summary')) {
        return {
          code: 0,
          data: {
            biz_data: {
              normal_wallets: [
                { balance: 4.25, currency: 'CNY', token_estimation: 1000 },
              ],
              bonus_wallets: [
                { balance: 1.5, currency: 'CNY', token_estimation: 500 },
              ],
            },
          },
        } as T;
      }
      if (input.url.includes('/api/v0/usage/cost')) {
        return {
          code: 0,
          data: [
            {
              currency: 'CNY',
              total: '0.85',
              days: [
                { day: '2026-05-25', cost: 0.42 },
                { day: '2026-05-26', cost: 0.18 },
                { day: '2026-05-27', cost: 0.25 },
              ],
            },
          ],
        } as T;
      }
      throw new Error(`unexpected url: ${input.url}`);
    };
    const adapter = createDeepSeekAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('deepseek'),
      getSecret: () => ({
        apiKey: 'sk-deepseek',
        deepseekUserToken: 'eyJhbGc-fake-token',
      }),
      now: NOW,
    });

    // The public balance endpoint MUST NOT be called when the
    // console path succeeds.
    expect(calls.some((c) => c.url.includes('api.deepseek.com'))).toBe(false);

    // The console path uses Bearer userToken, not the API key.
    expect(calls[0]!.headers?.Authorization).toBe('Bearer eyJhbGc-fake-token');
    expect(calls[0]!.url).toBe(
      'https://platform.deepseek.com/api/v0/users/get_user_summary',
    );
    expect(calls[1]!.url).toContain(
      'https://platform.deepseek.com/api/v0/usage/cost?year=',
    );

    expect(snapshot.status).toBe('ok');
    expect(snapshot.windows[0]!.name).toBe(
      'credits:CNY 总额 5.75 / 现金 4.25 / 赠金 1.50',
    );
    expect(snapshot.dailyUsage).toEqual([
      { date: '2026-05-25', cost: '0.42', totalTokens: 0 },
      { date: '2026-05-26', cost: '0.18', totalTokens: 0 },
      { date: '2026-05-27', cost: '0.25', totalTokens: 0 },
    ]);
  });

  it('falls back to the public balance path when the console call fails', async () => {
    const calls: RequestJsonInput[] = [];
    const request: RequestJson = async <T>(input: RequestJsonInput): Promise<T> => {
      calls.push(input);
      if (input.url.includes('/api/v0/users/get_user_summary')) {
        // Simulate a stale userToken — console rejects, public
        // balance still works via the API key.
        throw new Error('upstream returned HTTP 401');
      }
      if (input.url.includes('api.deepseek.com')) {
        return {
          is_available: true,
          balance_infos: [
            {
              currency: 'CNY',
              total_balance: '4.25',
              granted_balance: '0.00',
              topped_up_balance: '4.25',
            },
          ],
        } as T;
      }
      throw new Error(`unexpected url: ${input.url}`);
    };
    const adapter = createDeepSeekAdapter({ requestJson: request });

    const snapshot = await adapter.refresh({
      account: row('deepseek'),
      getSecret: () => ({
        apiKey: 'sk-deepseek',
        deepseekUserToken: 'stale-token',
      }),
      now: NOW,
    });

    // Console path attempted, then fell back to public balance.
    expect(calls[0]!.url).toContain(
      '/api/v0/users/get_user_summary',
    );
    expect(calls[calls.length - 1]!.url).toBe(
      'https://api.deepseek.com/user/balance',
    );
    expect(snapshot.status).toBe('ok');
    expect(snapshot.windows[0]!.name).toBe(
      'credits:CNY 总额 4.25 / 赠金 0.00 / 充值 4.25',
    );
    // Daily usage is absent on the fallback path.
    expect(snapshot.dailyUsage).toBeUndefined();
  });
});
describe('official quota adapters — Xiaomi MiMo', () => {
  // Helper: build a fake RequestRaw that returns scripted responses
  // keyed by URL substring. Each script entry consumes itself; passing
  // the same URL twice returns the next scripted response.
  type RawResponse = {
    status: number;
    headers?: Readonly<Record<string, readonly string[]>>;
    body: string;
  };

  function makeRequestRaw(
    script: ReadonlyArray<{ urlContains: string; respond: () => RawResponse }>,
  ): {
    requestRaw: (input: RequestJsonInput) => Promise<{
      status: number;
      headers: Readonly<Record<string, readonly string[]>>;
      body: string;
    }>;
    calls: RequestJsonInput[];
  } {
    const calls: RequestJsonInput[] = [];
    const remaining = script.map((entry) => ({ ...entry, used: false }));
    return {
      calls,
      requestRaw: async (input) => {
        calls.push(input);
        const idx = remaining.findIndex(
          (entry) => !entry.used && input.url.includes(entry.urlContains),
        );
        if (idx === -1) {
          throw new Error(`unexpected request: ${input.url}`);
        }
        remaining[idx]!.used = true;
        const r = remaining[idx]!.respond();
        return {
          status: r.status,
          headers: r.headers ?? {},
          body: r.body,
        };
      },
    };
  }

  // Fully synthetic credentials — never touch real account values.
  const FAKE_PASS_TOKEN = 'V1:fake-pass-token';
  const FAKE_USER_ID = '00000';
  const FAKE_NONCE = 'fake-nonce';
  const FAKE_SSECURITY = 'fake-ssecurity';
  const FAKE_LOCATION =
    'https://platform.xiaomimimo.com/sts?d=fake&nonce=' + FAKE_NONCE;
  const FAKE_SERVICE_TOKEN = 'fake-service-token';

  const SUCCESS_BALANCE_BODY = JSON.stringify({
    code: 0,
    message: '',
    data: {
      balance: '24.63',
      cashBalance: '24.63',
      giftBalance: '0.00',
      frozenBalance: '0.00',
      currency: 'CNY',
      overdraftLimit: '0.00',
      remainingOverdraftLimit: '0.00',
    },
  });

  const SUCCESS_USAGE_BODY = JSON.stringify({
    code: 0,
    data: [
      {
        date: '2026-05-26',
        model: 'mimo-v2.5-pro',
        apiKey: 'sk-x',
        totalToken: 1234,
        consumedAmount: '0.42',
      },
      {
        date: '2026-05-27',
        model: 'mimo-v2.5-pro',
        apiKey: 'sk-x',
        totalToken: 800,
        consumedAmount: '0.10',
      },
    ],
  });

  const SERVICE_LOGIN_BODY = '&&&START&&&' + JSON.stringify({
    code: 0,
    nonce: FAKE_NONCE,
    ssecurity: FAKE_SSECURITY,
    location: FAKE_LOCATION,
  });

  it('exchanges passToken for serviceToken and parses balance response', async () => {
    const { requestRaw, calls } = makeRequestRaw([
      {
        urlContains: '/pass/serviceLogin',
        respond: () => ({ status: 200, body: SERVICE_LOGIN_BODY }),
      },
      {
        urlContains: 'platform.xiaomimimo.com/sts',
        respond: () => ({
          status: 200,
          headers: {
            'set-cookie': [
              `api-platform_serviceToken="${FAKE_SERVICE_TOKEN}"; Path=/`,
              'userId=12345',
            ],
          },
          body: '',
        }),
      },
      {
        urlContains: '/api/v1/balance',
        respond: () => ({ status: 200, body: SUCCESS_BALANCE_BODY }),
      },
      {
        urlContains: '/api/v1/usage/detail/list',
        respond: () => ({ status: 200, body: SUCCESS_USAGE_BODY }),
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./xiaomi.adapter')).createXiaomiAdapter({
      requestRaw: requestRaw as any,
    });

    const snapshot = await adapter.refresh({
      account: row('xiaomi'),
      getSecret: () => ({
        xiaomiPassToken: FAKE_PASS_TOKEN,
        xiaomiUserId: FAKE_USER_ID,
      }),
      now: NOW,
    });

    expect(snapshot.status).toBe('ok');
    expect(snapshot.kind).toBe('credits');
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]!.name).toBe(
      'credits:CNY 总额 24.63 / 现金 24.63 / 赠金 0.00',
    );
    expect(snapshot.windows[0]!.percentLeft).toBeNull();
    // Daily-usage points are aggregated by date, ascending order.
    expect(snapshot.dailyUsage).toEqual([
      { date: '2026-05-26', cost: '0.4200', totalTokens: 1234 },
      { date: '2026-05-27', cost: '0.1000', totalTokens: 800 },
    ]);

    // Verify the request order and the cookie headers. The fourth call
    // is the daily-usage POST.
    expect(calls).toHaveLength(4);
    expect(calls[0]!.url).toContain('sid=api-platform');
    expect(calls[0]!.headers?.Cookie).toBe(
      `passToken=${FAKE_PASS_TOKEN}; userId=${FAKE_USER_ID}`,
    );
    expect(calls[1]!.url).toContain('clientSign=');
    expect(calls[2]!.url).toBe(
      'https://platform.xiaomimimo.com/api/v1/balance',
    );
    expect(calls[2]!.headers?.Cookie).toBe(
      `api-platform_serviceToken=${FAKE_SERVICE_TOKEN}; userId=${FAKE_USER_ID}`,
    );
    expect(calls[3]!.url).toBe(
      'https://platform.xiaomimimo.com/api/v1/usage/detail/list',
    );
    expect(calls[3]!.method).toBe('POST');
  });

  it('returns auth_missing when the passToken cookie is absent', async () => {
    const { requestRaw } = makeRequestRaw([]);
    const adapter = (await import('./xiaomi.adapter')).createXiaomiAdapter({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestRaw: requestRaw as any,
    });
    const snapshot = await adapter.refresh({
      account: row('xiaomi'),
      // Simulate a legacy row that was imported as an API key only.
      getSecret: () => ({ apiKey: 'sk-legacy' }),
      now: NOW,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('auth_missing');
  });

  it('reuses the cached serviceToken on subsequent refreshes', async () => {
    const cache = new Map<string, string>();
    const { requestRaw, calls } = makeRequestRaw([
      {
        urlContains: '/pass/serviceLogin',
        respond: () => ({ status: 200, body: SERVICE_LOGIN_BODY }),
      },
      {
        urlContains: 'platform.xiaomimimo.com/sts',
        respond: () => ({
          status: 200,
          headers: {
            'set-cookie': [
              `api-platform_serviceToken="${FAKE_SERVICE_TOKEN}"; Path=/`,
            ],
          },
          body: '',
        }),
      },
      // First refresh: balance + usage.
      {
        urlContains: '/api/v1/balance',
        respond: () => ({ status: 200, body: SUCCESS_BALANCE_BODY }),
      },
      {
        urlContains: '/api/v1/usage/detail/list',
        respond: () => ({ status: 200, body: SUCCESS_USAGE_BODY }),
      },
      // Second refresh: balance + usage (cached token reused, no
      // serviceLogin / sts roundtrip).
      {
        urlContains: '/api/v1/balance',
        respond: () => ({ status: 200, body: SUCCESS_BALANCE_BODY }),
      },
      {
        urlContains: '/api/v1/usage/detail/list',
        respond: () => ({ status: 200, body: SUCCESS_USAGE_BODY }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./xiaomi.adapter')).createXiaomiAdapter({
      requestRaw: requestRaw as any,
      serviceTokenCache: cache,
    });

    const account = row('xiaomi');
    await adapter.refresh({
      account,
      getSecret: () => ({
        xiaomiPassToken: FAKE_PASS_TOKEN,
        xiaomiUserId: FAKE_USER_ID,
      }),
      now: NOW,
    });
    await adapter.refresh({
      account,
      getSecret: () => ({
        xiaomiPassToken: FAKE_PASS_TOKEN,
        xiaomiUserId: FAKE_USER_ID,
      }),
      now: NOW + 1000,
    });

    // First refresh: serviceLogin + sts + balance + usage = 4 calls.
    // Second refresh: cached token reused, only balance + usage = 2 more.
    expect(calls).toHaveLength(6);
    expect(calls[4]!.url).toBe(
      'https://platform.xiaomimimo.com/api/v1/balance',
    );
    expect(calls[5]!.url).toBe(
      'https://platform.xiaomimimo.com/api/v1/usage/detail/list',
    );
    expect(cache.get(account.id)).toBe(FAKE_SERVICE_TOKEN);
  });

  it('refreshes the serviceToken when the cached one is rejected', async () => {
    const cache = new Map<string, string>();
    cache.set('xiaomi-id', 'stale-token');
    const { requestRaw, calls } = makeRequestRaw([
      // First /balance with stale token -> 401
      {
        urlContains: '/api/v1/balance',
        respond: () => ({ status: 401, body: '' }),
      },
      // Re-exchange
      {
        urlContains: '/pass/serviceLogin',
        respond: () => ({ status: 200, body: SERVICE_LOGIN_BODY }),
      },
      {
        urlContains: 'platform.xiaomimimo.com/sts',
        respond: () => ({
          status: 200,
          headers: {
            'set-cookie': [
              `api-platform_serviceToken="${FAKE_SERVICE_TOKEN}"; Path=/`,
            ],
          },
          body: '',
        }),
      },
      // Retry /balance with fresh token
      {
        urlContains: '/api/v1/balance',
        respond: () => ({ status: 200, body: SUCCESS_BALANCE_BODY }),
      },
      // Daily usage POST follows.
      {
        urlContains: '/api/v1/usage/detail/list',
        respond: () => ({ status: 200, body: SUCCESS_USAGE_BODY }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./xiaomi.adapter')).createXiaomiAdapter({
      requestRaw: requestRaw as any,
      serviceTokenCache: cache,
    });

    const snapshot = await adapter.refresh({
      account: row('xiaomi'),
      getSecret: () => ({
        xiaomiPassToken: FAKE_PASS_TOKEN,
        xiaomiUserId: FAKE_USER_ID,
      }),
      now: NOW,
    });

    expect(snapshot.status).toBe('ok');
    // 5 calls total: stale balance (401) + login + sts + balance retry + usage.
    expect(calls).toHaveLength(5);
    expect(cache.get('xiaomi-id')).toBe(FAKE_SERVICE_TOKEN);
  });

  it('reports auth_expired when the passToken itself is invalid', async () => {
    const { requestRaw } = makeRequestRaw([
      {
        urlContains: '/pass/serviceLogin',
        respond: () => ({
          status: 200,
          // Server returns a 200 with no `location` field — this is
          // how Xiaomi signals an expired passToken.
          body: '&&&START&&&' + JSON.stringify({ code: 70016 }),
        }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./xiaomi.adapter')).createXiaomiAdapter({
      requestRaw: requestRaw as any,
    });
    const snapshot = await adapter.refresh({
      account: row('xiaomi'),
      getSecret: () => ({
        xiaomiPassToken: FAKE_PASS_TOKEN,
        xiaomiUserId: FAKE_USER_ID,
      }),
      now: NOW,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('auth_expired');
  });

  it('preserves a 19-digit nonce verbatim across JSON parse (BigInt safety)', async () => {
    // Real Xiaomi nonces are 19-digit JSON numbers that overflow
    // Number.MAX_SAFE_INTEGER; precision must be preserved or the
    // SHA1 clientSign fails to match. This test pins that the
    // adapter extracts the digit string from the raw body rather
    // than re-stringifying the parsed double.
    const BIG_NONCE = '5964210357239677123';
    const SERVICE_LOGIN_BODY_BIG_NONCE =
      '&&&START&&&{"code":0,"nonce":' + BIG_NONCE +
      ',"ssecurity":"' + FAKE_SSECURITY +
      '","location":"' + FAKE_LOCATION + '"}';

    let observedStsUrl = '';
    const { requestRaw } = makeRequestRaw([
      {
        urlContains: '/pass/serviceLogin',
        respond: () => ({ status: 200, body: SERVICE_LOGIN_BODY_BIG_NONCE }),
      },
      {
        urlContains: 'platform.xiaomimimo.com/sts',
        respond: () => ({
          status: 200,
          headers: {
            'set-cookie': [
              `api-platform_serviceToken="${FAKE_SERVICE_TOKEN}"; Path=/`,
            ],
          },
          body: '',
        }),
      },
      {
        urlContains: '/api/v1/balance',
        respond: () => ({ status: 200, body: SUCCESS_BALANCE_BODY }),
      },
      {
        urlContains: '/api/v1/usage/detail/list',
        respond: () => ({ status: 200, body: SUCCESS_USAGE_BODY }),
      },
    ]);

    // Wrap requestRaw to capture the sts URL we end up issuing.
    const wrappedRaw = async (input: RequestJsonInput): Promise<{
      status: number;
      headers: Readonly<Record<string, readonly string[]>>;
      body: string;
    }> => {
      if (input.url.includes('platform.xiaomimimo.com/sts')) {
        observedStsUrl = input.url;
      }
      return requestRaw(input);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./xiaomi.adapter')).createXiaomiAdapter({
      requestRaw: wrappedRaw as any,
    });

    const snapshot = await adapter.refresh({
      account: row('xiaomi'),
      getSecret: () => ({
        xiaomiPassToken: FAKE_PASS_TOKEN,
        xiaomiUserId: FAKE_USER_ID,
      }),
      now: NOW,
    });

    expect(snapshot.status).toBe('ok');

    // Compute the expected clientSign from the verbatim 19-digit nonce.
    const crypto = await import('node:crypto');
    const expectedSign = crypto
      .createHash('sha1')
      .update(`nonce=${BIG_NONCE}&${FAKE_SSECURITY}`, 'utf-8')
      .digest('base64');
    const expectedQuery = `clientSign=${encodeURIComponent(expectedSign)}`;
    expect(observedStsUrl).toContain(expectedQuery);
  });
});

describe('official quota adapters — OpenCode Go', () => {
  // The dashboard at https://opencode.ai/workspace/<id>/go is
  // SolidStart SSR HTML; the adapter scrapes data-slot attributes
  // out of it. Auth is an opaque Iron-encrypted `auth` cookie.
  type RawResponse = {
    status: number;
    headers?: Readonly<Record<string, readonly string[]>>;
    body: string;
  };

  function makeRequestRaw(
    script: ReadonlyArray<{ urlContains: string; respond: () => RawResponse }>,
  ): {
    requestRaw: (input: RequestJsonInput) => Promise<{
      status: number;
      headers: Readonly<Record<string, readonly string[]>>;
      body: string;
    }>;
    calls: RequestJsonInput[];
  } {
    const calls: RequestJsonInput[] = [];
    const remaining = script.map((entry) => ({ ...entry, used: false }));
    return {
      calls,
      requestRaw: async (input) => {
        calls.push(input);
        const idx = remaining.findIndex(
          (entry) => !entry.used && input.url.includes(entry.urlContains),
        );
        if (idx === -1) {
          throw new Error(`unexpected request: ${input.url}`);
        }
        remaining[idx]!.used = true;
        const r = remaining[idx]!.respond();
        return {
          status: r.status,
          headers: r.headers ?? {},
          body: r.body,
        };
      },
    };
  }

  // Synthetic credentials — never touch real account values.
  const FAKE_AUTH_COOKIE = 'Fe26.2**fake-iron-cookie-blob';
  const FAKE_WORKSPACE_URL =
    'https://opencode.ai/workspace/wrk_FAKEFAKEFAKEFAKEFAKEFAKE/go';

  // Snippet of real Solid-rendered HTML pulled from the Go dashboard
  // (real values redacted to a stable mock so tests do not drift
  // when the user's actual account data changes).
  const SUCCESS_HTML = `
<!DOCTYPE html>
<html><body>
<div data-slot="usage">
  <div data-slot="usage-item">
    <span data-slot="usage-label">滚动用量</span>
    <span data-slot="usage-value"><!--$-->0<!--/-->%</span>
    <div data-slot="progress"><div data-slot="progress-bar" style="width:0%"></div></div>
    <span data-slot="reset-time"><!--$-->重置于<!--/--> <!--$-->5 小时 0 分钟<!--/--></span>
  </div><!--/-->
  <div data-slot="usage-item">
    <span data-slot="usage-label">每周用量</span>
    <span data-slot="usage-value"><!--$-->6<!--/-->%</span>
    <div data-slot="progress"><div data-slot="progress-bar" style="width:6%"></div></div>
    <span data-slot="reset-time"><!--$-->重置于<!--/--> <!--$-->4 天 18 小时<!--/--></span>
  </div><!--/-->
  <div data-slot="usage-item">
    <span data-slot="usage-label">每月用量</span>
    <span data-slot="usage-value"><!--$-->62<!--/-->%</span>
    <div data-slot="progress"><div data-slot="progress-bar" style="width:62%"></div></div>
    <span data-slot="reset-time"><!--$-->重置于<!--/--> <!--$-->11 天 21 小时<!--/--></span>
  </div><!--/-->
</div>
</body></html>
`;

  it('parses SSR-rendered usage rows into three QuotaWindows', async () => {
    const { requestRaw, calls } = makeRequestRaw([
      {
        urlContains: '/workspace/',
        respond: () => ({ status: 200, body: SUCCESS_HTML }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./opencode.adapter')).createOpenCodeAdapter({
      requestRaw: requestRaw as any,
    });

    const snapshot = await adapter.refresh({
      account: row('opencode'),
      getSecret: () => ({
        opencodeAuthCookie: FAKE_AUTH_COOKIE,
        opencodeWorkspaceUrl: FAKE_WORKSPACE_URL,
      }),
      now: NOW,
    });

    expect(snapshot.status).toBe('ok');
    expect(snapshot.kind).toBe('quota');
    expect(snapshot.windows).toHaveLength(3);
    // Three rows: 5h, 7d, 30d. percentLeft is `100 - usage%`.
    expect(snapshot.windows[0]).toMatchObject({
      name: 'opencode-5h',
      percentLeft: 100,
      windowSeconds: 5 * 60 * 60,
    });
    expect(snapshot.windows[1]).toMatchObject({
      name: 'opencode-7d',
      percentLeft: 94,
      windowSeconds: 7 * 24 * 60 * 60,
    });
    expect(snapshot.windows[2]).toMatchObject({
      name: 'opencode-30d',
      percentLeft: 38,
      windowSeconds: 30 * 24 * 60 * 60,
    });
    // resetAt is `now + duration`. The 30d row says "11 天 21 小时".
    const expected30d =
      NOW + 11 * 86_400_000 + 21 * 3_600_000;
    expect(snapshot.windows[2]!.resetAt).toBe(expected30d);

    // Cookie is forwarded verbatim.
    expect(calls[0]!.headers?.Cookie).toBe(`auth=${FAKE_AUTH_COOKIE}`);
    expect(calls[0]!.url).toBe(FAKE_WORKSPACE_URL);
  });

  it('reports auth_expired on a 3xx redirect (login page)', async () => {
    const { requestRaw } = makeRequestRaw([
      {
        urlContains: '/workspace/',
        respond: () => ({
          status: 302,
          headers: { location: ['/auth/login'] },
          body: '',
        }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./opencode.adapter')).createOpenCodeAdapter({
      requestRaw: requestRaw as any,
    });
    const snapshot = await adapter.refresh({
      account: row('opencode'),
      getSecret: () => ({
        opencodeAuthCookie: FAKE_AUTH_COOKIE,
        opencodeWorkspaceUrl: FAKE_WORKSPACE_URL,
      }),
      now: NOW,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('auth_expired');
  });

  it('reports auth_expired on HTTP 500 (stale Iron session)', async () => {
    // opencode.ai answers 500 — not 302/401 — when the Iron
    // session has been invalidated server-side. We surface this
    // as auth_expired so users know to re-paste the cookie.
    const { requestRaw } = makeRequestRaw([
      {
        urlContains: '/workspace/',
        respond: () => ({ status: 500, body: '500 | Internal Server Error' }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./opencode.adapter')).createOpenCodeAdapter({
      requestRaw: requestRaw as any,
    });
    const snapshot = await adapter.refresh({
      account: row('opencode'),
      getSecret: () => ({
        opencodeAuthCookie: FAKE_AUTH_COOKIE,
        opencodeWorkspaceUrl: FAKE_WORKSPACE_URL,
      }),
      now: NOW,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('auth_expired');
  });

  it('returns auth_missing when secret payload lacks both fields', async () => {
    const { requestRaw } = makeRequestRaw([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./opencode.adapter')).createOpenCodeAdapter({
      requestRaw: requestRaw as any,
    });
    const snapshot = await adapter.refresh({
      account: row('opencode'),
      getSecret: () => ({}),
      now: NOW,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('auth_missing');
  });

  it('reports upstream_changed when the data-slot block is missing', async () => {
    const { requestRaw } = makeRequestRaw([
      {
        urlContains: '/workspace/',
        respond: () => ({
          status: 200,
          body: '<html><body><div>nothing here</div></body></html>',
        }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./opencode.adapter')).createOpenCodeAdapter({
      requestRaw: requestRaw as any,
    });
    const snapshot = await adapter.refresh({
      account: row('opencode'),
      getSecret: () => ({
        opencodeAuthCookie: FAKE_AUTH_COOKIE,
        opencodeWorkspaceUrl: FAKE_WORKSPACE_URL,
      }),
      now: NOW,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('upstream_changed');
  });

  it('accepts a path-only workspace URL and prepends the canonical host', async () => {
    const { requestRaw, calls } = makeRequestRaw([
      {
        urlContains: '/workspace/',
        respond: () => ({ status: 200, body: SUCCESS_HTML }),
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = (await import('./opencode.adapter')).createOpenCodeAdapter({
      requestRaw: requestRaw as any,
    });
    await adapter.refresh({
      account: row('opencode'),
      getSecret: () => ({
        opencodeAuthCookie: FAKE_AUTH_COOKIE,
        opencodeWorkspaceUrl: '/workspace/wrk_FAKE/go',
      }),
      now: NOW,
    });
    expect(calls[0]!.url).toBe(
      'https://opencode.ai/workspace/wrk_FAKE/go',
    );
  });
});
