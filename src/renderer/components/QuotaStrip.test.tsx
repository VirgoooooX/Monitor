// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { QuotaStrip, UsageSparkline } from './QuotaStrip';
import type { QuotaSnapshot, QuotaStatus } from '../lib/types';

function snapshot(overrides: Partial<QuotaSnapshot>): QuotaSnapshot {
  return {
    provider: 'gemini-cli',
    capturedAt: 1_779_845_160_000,
    source: 'imported_auth',
    windows: [],
    providerAuthId: 'provider-auth-1',
    accountLabel: 'Gemini CLI',
    accountId: null,
    projectId: 'project-1',
    kind: 'quota',
    status: 'ok',
    rawPlanLabel: 'Pro',
    modelGroup: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

function installDesktopBridge(status: QuotaStatus): void {
  vi.stubGlobal('desktop', {
    getQuotaStatus: vi.fn(async () => status),
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

describe('QuotaStrip', () => {
  it('shows all quota rows in constrained-priority order', async () => {
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'codex',
          providerAuthId: 'codex-1',
          accountLabel: 'Codex',
          windows: [
            {
              name: '5h',
              percentLeft: 47,
              resetAt: new Date(2026, 4, 27, 12, 35).getTime(),
              windowSeconds: 18_000,
            },
            {
              name: 'weekly',
              percentLeft: 31,
              resetAt: new Date(2026, 4, 31, 14, 42).getTime(),
              windowSeconds: 604_800,
            },
          ],
        }),
        snapshot({
          provider: 'antigravity',
          providerAuthId: 'ag-1',
          accountLabel: 'Antigravity',
          windows: [
            { name: 'MODEL_PLACEHOLDER_M26', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
            // Two raw Claude rows that both map to "Claude" — they
            // collapse into a single averaged row at render time:
            // (80 + 60) / 2 = 70%.
            { name: 'MODEL_CLAUDE_OPUS_4_6', percentLeft: 80, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_CLAUDE_SONNET_4_6', percentLeft: 60, resetAt: 1_779_858_000_000, windowSeconds: null },
            // All Gemini variants share one quota pool on Antigravity.
            // They land in the single "Gemini" bucket, averaged together.
            // Image is filtered out (separate pool, rarely used).
            // (90 + 80 + 75 + 100) / 4 = 86.25 → 86%.
            { name: 'MODEL_GOOGLE_GEMINI_2_5_PRO', percentLeft: 90, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_GOOGLE_GEMINI_2_5_FLASH', percentLeft: 80, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE', percentLeft: 75, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_CHAT_20706', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
            // Image — filtered out, must NOT contribute to the Gemini average.
            { name: 'MODEL_CHAT_23310', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_GOOGLE_GEMINI_3_1_FLASH_IMAGE', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
          ],
        }),
      ],
    });

    render(<QuotaStrip />);

    expect(await screen.findByTestId('quota-strip')).toBeTruthy();

    await waitFor(() => {
      // 2 codex (5h, weekly) + 2 antigravity (Claude, Gemini)
      // OpenAI/GPT and placeholders are filtered out.
      expect(document.querySelectorAll('.quota-strip__row')).toHaveLength(4);
    });
    expect(screen.getByText('周限额')).toBeTruthy();
    expect(screen.getByText('5 小时限额')).toBeTruthy();
    // Exactly one "Claude" and one "Gemini" row.
    expect(screen.getAllByText('Claude')).toHaveLength(1);
    expect(screen.getAllByText('Gemini')).toHaveLength(1);
    expect(screen.getByText('70%')).toBeTruthy(); // Claude: avg of 80 + 60
    expect(screen.getByText('86%')).toBeTruthy(); // Gemini: avg of 90+80+75+100 (Image excluded)
    expect(screen.queryByText('Claude/GPT')).toBeNull();
    expect(screen.queryByText('Gemini 3 Flash')).toBeNull();
    expect(screen.queryByText('Gemini 3.1 Pro Series')).toBeNull();
    expect(screen.queryByText('Gemini 3.5 Flash Series')).toBeNull();
    expect(screen.queryByText('Gemini 3.1 Flash Image')).toBeNull();
    expect(screen.getByText('05/27 12:35')).toBeTruthy();
    expect(screen.getByText('05/31 14:42')).toBeTruthy();
    expect(screen.queryByText(/另 1 项/)).toBeNull();
    expect(screen.queryByText(/MODEL_PLACEHOLDER/)).toBeNull();
    expect(screen.queryByText(/MODEL_OPENAI/)).toBeNull();
  });
});

describe('QuotaStrip — credits rows', () => {
  it('renders credits-style rows (DeepSeek balance) as a balance badge instead of a progress bar', async () => {
    installDesktopBridge({
      snapshots: [
        {
          provider: 'deepseek',
          capturedAt: 1_779_845_160_000,
          source: 'imported_auth',
          providerAuthId: 'deepseek-1',
          accountLabel: 'DeepSeek',
          accountId: null,
          projectId: null,
          kind: 'credits',
          status: 'ok',
          rawPlanLabel: null,
          modelGroup: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          windows: [
            {
              name: 'credits:CNY 总额 4.25 / 赠金 0.00 / 充值 4.25',
              percentLeft: 100,
              resetAt: null,
              windowSeconds: null,
            },
          ],
        },
      ],
    });

    render(<QuotaStrip />);

    expect(await screen.findByTestId('quota-strip')).toBeTruthy();

    await waitFor(() => {
      expect(document.querySelectorAll('.quota-strip__row--credits')).toHaveLength(1);
    });
    // Balance amount with currency symbol is the primary visual.
    expect(screen.getByText('¥4.25')).toBeTruthy();
    // Tag combines "余额" and the currency code.
    expect(screen.getByText('余额 · CNY')).toBeTruthy();
    // Misleading "100%" / progress bar must not appear for credits rows.
    expect(screen.queryByText('100%')).toBeNull();
    expect(document.querySelector('.quota-strip__row--credits .quota-strip__track')).toBeNull();
  });
});

describe('UsageSparkline', () => {
  it('uses totalTokens before cost when token usage is available', () => {
    render(
      <UsageSparkline
        dailyUsage={[
          { date: '2026-06-12', cost: '0', totalTokens: 0 },
          { date: '2026-06-13', cost: '0', totalTokens: 2400 },
        ]}
        currencySymbol="¥"
        currencyCode="CNY"
      />,
    );

    expect(document.querySelector('.quota-strip__sparkline')?.getAttribute('data-has-data')).toBe('true');
    expect(screen.getByText('2026-06-13 · 2.4k tok')).toBeTruthy();
  });

  it('falls back to cost when token usage is unavailable', () => {
    render(
      <UsageSparkline
        dailyUsage={[
          { date: '2026-06-12', cost: '0.18', totalTokens: 0 },
        ]}
        currencySymbol="¥"
        currencyCode="CNY"
      />,
    );

    expect(document.querySelector('.quota-strip__sparkline')?.getAttribute('data-has-data')).toBe('true');
    expect(screen.getByText('2026-06-12 · ¥0.18 CNY')).toBeTruthy();
  });
});
