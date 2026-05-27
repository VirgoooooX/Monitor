// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { UsagePanel } from './UsagePanel';
import type { QuotaSnapshot, QuotaStatus, UsageSummary } from '../lib/types';

function makeSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    provider: 'codex',
    capturedAt: 1_779_845_160_000,
    source: 'imported_auth',
    windows: [
      { name: '5h', percentLeft: 66, resetAt: 1_779_858_000_000, windowSeconds: 18_000 },
      { name: 'weekly', percentLeft: 34, resetAt: 1_780_238_400_000, windowSeconds: 604_800 },
    ],
    providerAuthId: 'provider-auth-1',
    accountLabel: 'codex_oauth_vigoss.xia@gmail.com.json',
    accountId: 'acct-codex-1',
    projectId: null,
    kind: 'quota',
    status: 'ok',
    rawPlanLabel: 'Plus',
    modelGroup: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function installDesktopBridge(quotaStatus: QuotaStatus, usage: UsageSummary = { range: 'today', perProvider: [] }): void {
  vi.stubGlobal('desktop', {
    getUsageSummary: vi.fn(async () => usage),
    getQuotaStatus: vi.fn(async () => quotaStatus),
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UsagePanel quota overview', () => {
  it('renders CPA-style account cards with multiple quota rows', async () => {
    installDesktopBridge({
      snapshots: [
        makeSnapshot(),
        makeSnapshot({
          provider: 'gemini-cli',
          providerAuthId: 'provider-auth-2',
          accountLabel: 'Gemini CLI (chamber-tracker-82406)',
          accountId: null,
          projectId: 'chamber-tracker-82406',
          rawPlanLabel: 'Pro',
          status: 'stale',
          lastErrorCode: 'upstream_unauthorized',
          lastErrorMessage: 'upstream returned HTTP 401',
          windows: [
            { name: 'gemini-2.5-pro:input', percentLeft: 99, resetAt: 1_779_887_000_000, windowSeconds: 86_400 },
          ],
        }),
        makeSnapshot({
          provider: 'antigravity',
          providerAuthId: 'provider-auth-3',
          accountLabel: 'Antigravity (emerald-spider-tflbb)',
          accountId: null,
          projectId: 'emerald-spider-tflbb',
          rawPlanLabel: null,
          windows: [
            { name: 'MODEL_PLACEHOLDER_M26', percentLeft: 100, resetAt: 1_779_920_000_000, windowSeconds: null },
            { name: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', percentLeft: 100, resetAt: 1_779_920_000_000, windowSeconds: null },
            { name: 'MODEL_GOOGLE_GEMINI_2_5_PRO', percentLeft: 100, resetAt: 1_779_920_000_000, windowSeconds: null },
          ],
        }),
      ],
    });

    render(<UsagePanel />);

    expect(await screen.findByText('v***a@gmail.com')).toBeTruthy();
    expect(screen.getByText('chamber-tracker-82406')).toBeTruthy();
    expect(screen.getByText('emerald-spider-tflbb')).toBeTruthy();
    expect(screen.getByText('3 个账号')).toBeTruthy();
    expect(screen.getByText('5 小时限额')).toBeTruthy();
    expect(screen.getByText('周限额')).toBeTruthy();
    expect(screen.getByText('Gemini Pro')).toBeTruthy();
    expect(screen.getByText('Gemini')).toBeTruthy();
    expect(screen.queryByText('Claude/GPT')).toBeNull();
    expect(screen.queryByText('Gemini Pro Series')).toBeNull();
    expect(screen.queryByText('Gemini 3.1 Pro Series')).toBeNull();
    expect(screen.getByText('Plus')).toBeTruthy();
    expect(screen.getByText('Pro')).toBeTruthy();
    expect(screen.getByText('上游拒绝')).toBeTruthy();
    expect(screen.getByText('upstream returned HTTP 401')).toBeTruthy();
    expect(screen.queryByText(/MODEL_PLACEHOLDER/)).toBeNull();
    expect(screen.queryByText(/MODEL_OPENAI/)).toBeNull();

    await waitFor(() => {
      expect(document.querySelectorAll('.quota-account-card')).toHaveLength(3);
      // Antigravity rows: only MODEL_GOOGLE_GEMINI_2_5_PRO survives the filter
      // (placeholder + OpenAI GPT are dropped) → folds into the single
      // "Gemini" bucket. Plus codex 2 + gemini-cli 1 = 4.
      expect(document.querySelectorAll('.quota-window-row')).toHaveLength(4);
    });
  });
});

describe('UsagePanel quota card kinds and states', () => {
  it('renders credits kind, health kind, and empty state cards properly', async () => {
    installDesktopBridge({
      snapshots: [
        makeSnapshot({
          provider: 'deepseek',
          providerAuthId: 'provider-auth-deepseek',
          accountLabel: 'DeepSeek Credits Account',
          kind: 'credits',
          windows: [
            { name: 'credits:USD 总额 15.00 / 赠金 5.00 / 充值 10.00', percentLeft: null, resetAt: null, windowSeconds: null }
          ],
          dailyUsage: [
            { date: '2026-05-27', cost: '1.20', totalTokens: 5000 },
            { date: '2026-05-26', cost: '0.80', totalTokens: 3000 }
          ]
        }),
        makeSnapshot({
          provider: 'gemini-api',
          providerAuthId: 'provider-auth-gemini-api',
          accountLabel: 'Gemini API Health Check',
          kind: 'health',
          windows: []
        })
      ]
    });

    render(<UsagePanel />);

    // DeepSeek credits verification
    expect(await screen.findByText('DeepSeek Credits Account')).toBeTruthy();
    expect(screen.getByText('$15.00')).toBeTruthy(); // total amount formatted with currency symbol
    expect(screen.getByText('余额')).toBeTruthy();

    // Gemini API health check verification (kind: health displays "暂无额度数据")
    expect(screen.getByText('Gemini API Health Check')).toBeTruthy();
    expect(screen.getByText('暂无额度数据')).toBeTruthy();
  });
});

describe('UsagePanel token consumption list', () => {
  it('renders empty state when there is no usage data', async () => {
    installDesktopBridge({ snapshots: [] }, { range: 'today', perProvider: [] });
    render(<UsagePanel />);
    expect(await screen.findByText('暂无 Token 记录')).toBeTruthy();
    expect(screen.getByText('已开始采集，下一次刷新后会显示本地日志或官方日用量。')).toBeTruthy();
  });

  it('renders provider cards with and without token breakdown and from daily usage fallback', async () => {
    installDesktopBridge(
      { snapshots: [] },
      {
        range: 'today',
        perProvider: [
          {
            provider: 'codex',
            status: 'ok',
            inputTokens: 1000,
            outputTokens: 500,
            cacheTokens: 200,
            costUsd: 0.05,
            eventCount: 3,
            source: 'events',
            hasTokenBreakdown: true
          },
          {
            provider: 'gemini-cli',
            status: 'degraded',
            inputTokens: 0,
            outputTokens: 0,
            cacheTokens: 0,
            costUsd: null,
            eventCount: 5,
            source: 'events',
            hasTokenBreakdown: false
          },
          {
            provider: 'deepseek',
            status: 'ok',
            inputTokens: 8000,
            outputTokens: 0,
            cacheTokens: 0,
            costUsd: 0.12,
            eventCount: 0,
            source: 'quotaDailyUsage',
            hasTokenBreakdown: false
          }
        ]
      }
    );

    render(<UsagePanel />);

    // Totals summary checks
    await waitFor(() => {
      expect(document.querySelector('.usage-totals')).toBeTruthy();
    });
    const totalsContainer = document.querySelector('.usage-totals') as HTMLElement;
    expect(within(totalsContainer).getByText('总 Tokens')).toBeTruthy();
    expect(within(totalsContainer).getByText(/In\s*9\.0k\s*·\s*Out\s*500\s*·\s*Cache\s*200/)).toBeTruthy();
    expect(within(totalsContainer).getByText('预估费用')).toBeTruthy();
    expect(screen.getByText('$0.17')).toBeTruthy(); // 0.05 + 0.12

    // Codex: events with breakdown
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Input')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
    expect(screen.getByText('Cache')).toBeTruthy();
    expect(screen.getByText('1.7k')).toBeTruthy(); // total: 1700
    expect(screen.getByText('3')).toBeTruthy(); // requests count

    // Gemini API / CLI: events without breakdown
    expect(screen.getByText('Gemini CLI')).toBeTruthy();
    expect(screen.getByText('已记录请求，暂无 token 字段')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy(); // requests count

    // DeepSeek: daily usage fallback
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.getByText('来自官方日用量')).toBeTruthy();
    expect(screen.getByText('8.0k')).toBeTruthy();
    expect(screen.getByText('官方费用')).toBeTruthy();
    expect(screen.getByText('$0.12')).toBeTruthy();
  });
});
