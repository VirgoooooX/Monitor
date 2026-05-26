// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

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

function installDesktopBridge(quotaStatus: QuotaStatus): void {
  const usage: UsageSummary = { range: 'today', perProvider: [] };

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

    expect(await screen.findByText('codex_oauth_vigoss.xia@gmail.com.json')).toBeTruthy();
    expect(screen.getByText('Gemini CLI (chamber-tracker-82406)')).toBeTruthy();
    expect(screen.getByText('Antigravity (emerald-spider-tflbb)')).toBeTruthy();
    expect(screen.getByText('按账号显示')).toBeTruthy();
    expect(screen.getByText('5 小时限额')).toBeTruthy();
    expect(screen.getByText('周限额')).toBeTruthy();
    expect(screen.getByText('Gemini Pro Series')).toBeTruthy();
    expect(screen.getByText('Claude/GPT')).toBeTruthy();
    expect(screen.getByText('Gemini 3.1 Pro Series')).toBeTruthy();
    expect(screen.getByText('Plus')).toBeTruthy();
    expect(screen.getByText('Pro')).toBeTruthy();
    expect(screen.getByText('上游拒绝')).toBeTruthy();
    expect(screen.getByText('upstream returned HTTP 401')).toBeTruthy();
    expect(screen.queryByText(/MODEL_PLACEHOLDER/)).toBeNull();

    await waitFor(() => {
      expect(document.querySelectorAll('.quota-account-card')).toHaveLength(3);
      expect(document.querySelectorAll('.quota-window-row')).toHaveLength(5);
    });
  });
});
