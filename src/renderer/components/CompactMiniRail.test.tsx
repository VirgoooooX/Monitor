// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { CompactMiniRail } from './CompactMiniRail';
import type { QuotaSnapshot, QuotaStatus, DashboardState } from '../lib/types';

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

function mockDashboardState(overrides?: Partial<DashboardState>): DashboardState {
  return {
    status: 'healthy',
    statusLabel: '外网正常',
    generatedAt: Date.now(),
    router: { ok: true, lastChange: Date.now() },
    openclash: { tcpOk: true, apiOk: true, mode: 'rule' },
    currentNode: {
      group: '日本04',
      node: '日本A04 | IEPL',
      avgLatencyMs: 128,
      probeResults: [],
      successRate5: 1,
      sparkline: [],
    },
    usageToday: { codex: 0, gemini: 0, opencode: 0 },
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

describe('CompactMiniRail', () => {
  it('filters out providers with percentLeft: null or no windows', async () => {
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'codex',
          accountLabel: 'Codex',
          windows: [
            {
              name: '5h',
              percentLeft: null,
              resetAt: Date.now(),
              windowSeconds: 18_000,
            },
          ],
        }),
        snapshot({
          provider: 'deepseek',
          accountLabel: 'DeepSeek',
          windows: [], // no windows
        }),
        snapshot({
          provider: 'gemini-api',
          accountLabel: 'Gemini API',
          windows: [
            {
              name: 'weekly',
              percentLeft: 85,
              resetAt: Date.now(),
              windowSeconds: null,
            },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);

    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();

    await waitFor(() => {
      // Gemini API should render (85%)
      expect(screen.getByLabelText(/Gemini API/)).toBeTruthy();
      // Codex and DeepSeek should be filtered out
      expect(screen.queryByLabelText(/Codex/)).toBeNull();
      expect(screen.queryByLabelText(/DeepSeek/)).toBeNull();
    });
  });

  it('prefers 5h window for codex', async () => {
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'codex',
          accountLabel: 'Codex Label',
          windows: [
            {
              name: '5h',
              percentLeft: 40,
              resetAt: Date.now(),
              windowSeconds: 18_000,
            },
            {
              name: 'weekly',
              percentLeft: 90,
              resetAt: Date.now(),
              windowSeconds: 604_800,
            },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);

    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();

    await waitFor(() => {
      // Codex Label should be shown with 40% (the 5h window) rather than 90%
      expect(screen.getByLabelText('Codex Label · 40%')).toBeTruthy();
    });
  });

  it('aggregates multi-window providers using average value', async () => {
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'gemini-cli',
          accountLabel: 'Gemini CLI Label',
          windows: [
            { name: 'gemini-3.1-pro', percentLeft: 60, resetAt: Date.now(), windowSeconds: null },
            { name: 'gemini-3.1-flash-lite', percentLeft: 80, resetAt: Date.now(), windowSeconds: null },
          ],
        }),
        snapshot({
          provider: 'antigravity',
          accountLabel: 'Antigravity Label',
          windows: [
            { name: 'MODEL_CLAUDE_OPUS_4_6', percentLeft: 30, resetAt: Date.now(), windowSeconds: null },
            { name: 'MODEL_GOOGLE_GEMINI_3_1_PRO', percentLeft: 50, resetAt: Date.now(), windowSeconds: null },
            { name: 'MODEL_CHAT_23310', percentLeft: 70, resetAt: Date.now(), windowSeconds: null },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);

    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();

    await waitFor(() => {
      // average: (60 + 80) / 2 = 70%
      expect(screen.getByLabelText('Gemini CLI Label · 70%')).toBeTruthy();
      // average: (30 + 50) / 2 = 40% (MODEL_CHAT_23310 is filtered out)
      expect(screen.getByLabelText('Antigravity Label · 40%')).toBeTruthy();
    });
  });

  it('renders xiaomi only when it has valid percentage data', async () => {
    // 1. First test where xiaomi has no valid percent data
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'xiaomi',
          accountLabel: '小米账号',
          windows: [],
        }),
      ],
    });

    const { rerender } = render(<CompactMiniRail state={mockDashboardState()} />);
    await waitFor(() => {
      expect(screen.queryByLabelText(/小米/)).toBeNull();
    });

    cleanup();

    // 2. Second test where xiaomi has valid percent data
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'xiaomi',
          accountLabel: '小米账号',
          windows: [
            { name: 'weekly', percentLeft: 95, resetAt: Date.now(), windowSeconds: null },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByLabelText('小米账号 · 95%')).toBeTruthy();
    });
  });

  it('sorts badges in designated order, followed by unknown providers sorted alphabetically', async () => {
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'z-unknown',
          accountLabel: 'Z Unknown',
          windows: [{ name: 'weekly', percentLeft: 80, resetAt: Date.now(), windowSeconds: null }],
        }),
        snapshot({
          provider: 'antigravity',
          accountLabel: 'Antigravity',
          windows: [{ name: 'MODEL_CLAUDE_OPUS_4_6', percentLeft: 80, resetAt: Date.now(), windowSeconds: null }],
        }),
        snapshot({
          provider: 'a-unknown',
          accountLabel: 'A Unknown',
          windows: [{ name: 'weekly', percentLeft: 80, resetAt: Date.now(), windowSeconds: null }],
        }),
        snapshot({
          provider: 'codex',
          accountLabel: 'Codex',
          windows: [{ name: 'weekly', percentLeft: 80, resetAt: Date.now(), windowSeconds: null }],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);

    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();

    await waitFor(() => {
      const providers = document.querySelectorAll('.compact-mini-rail__provider');
      expect(providers).toHaveLength(4);

      // Order should be: codex, antigravity, A Unknown, Z Unknown
      expect(providers[0]?.getAttribute('aria-label')).toContain('Codex');
      expect(providers[1]?.getAttribute('aria-label')).toContain('Antigravity');
      expect(providers[2]?.getAttribute('aria-label')).toContain('A Unknown');
      expect(providers[3]?.getAttribute('aria-label')).toContain('Z Unknown');
    });
  });

  it('displays network status label and latency in title/aria-label correctly', async () => {
    render(
      <CompactMiniRail
        state={mockDashboardState({
          status: 'healthy',
          statusLabel: '外网正常',
          currentNode: {
            group: '日本04',
            node: '日本A04',
            avgLatencyMs: 88,
            probeResults: [],
            successRate5: 1,
            sparkline: [],
          },
        })}
      />,
    );

    const networkElement = document.querySelector('.compact-mini-rail__network');
    expect(networkElement).toBeTruthy();
    expect(networkElement?.getAttribute('aria-label')).toBe('外网正常 · 88ms');
    expect(networkElement?.getAttribute('title')).toBe('外网正常 · 88ms');
  });
});
