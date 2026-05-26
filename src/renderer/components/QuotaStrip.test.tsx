// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { QuotaStrip } from './QuotaStrip';
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
  it('shows the most constrained quota rows and folds the rest', async () => {
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'codex',
          providerAuthId: 'codex-1',
          accountLabel: 'Codex',
          windows: [
            { name: '5h', percentLeft: 47, resetAt: 1_779_858_000_000, windowSeconds: 18_000 },
            { name: 'weekly', percentLeft: 31, resetAt: 1_780_238_400_000, windowSeconds: 604_800 },
          ],
        }),
        snapshot({
          provider: 'antigravity',
          providerAuthId: 'ag-1',
          accountLabel: 'Antigravity',
          windows: [
            { name: 'MODEL_PLACEHOLDER_M26', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_GOOGLE_GEMINI_2_5_PRO', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_GOOGLE_GEMINI_2_5_FLASH', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
            { name: 'MODEL_CHAT_20706', percentLeft: 100, resetAt: 1_779_858_000_000, windowSeconds: null },
          ],
        }),
      ],
    });

    render(<QuotaStrip />);

    expect(await screen.findByTestId('quota-strip')).toBeTruthy();

    await waitFor(() => {
      expect(document.querySelectorAll('.quota-strip__row')).toHaveLength(5);
    });
    expect(screen.getByText('周')).toBeTruthy();
    expect(screen.getByText('5h')).toBeTruthy();
    expect(screen.getByText('GPT')).toBeTruthy();
    expect(screen.getByText('另 1 项')).toBeTruthy();
    expect(screen.queryByText(/MODEL_PLACEHOLDER/)).toBeNull();
  });
});
