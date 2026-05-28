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
      // Codex (no usable percent) and DeepSeek (no windows) should be filtered out
      expect(screen.queryByLabelText(/Codex/)).toBeNull();
      expect(screen.queryByLabelText(/DeepSeek/)).toBeNull();
    });
  });

  it('codex 5h=100%/周=1% folds weekly into the effective ring (痛点 case)', async () => {
    // WEEKLY_PER_5H_CODEX = 0.28 → weekly_as_5h = 1/0.28 ≈ 3.57
    // effective = min(100, 3.57) → 4 (rounded), critical tone.
    // The badge label includes the original 5h/周 readings AND the
    // derived "实际" so the user can reconcile a 4% red ring against
    // the misleadingly green 5h reading.
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'codex',
          accountLabel: 'Codex Label',
          windows: [
            { name: '5h',     percentLeft: 100, resetAt: Date.now(), windowSeconds: 18_000 },
            { name: 'weekly', percentLeft: 1,   resetAt: Date.now(), windowSeconds: 604_800 },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();

    await waitFor(() => {
      // 1 / 0.28 ≈ 3.57 → clamp+round to 4.
      const badge = screen.getByLabelText('Codex Label · 5h 100% · 周 1% · 实际 4%');
      expect(badge).toBeTruthy();
      // Effective is in critical band (≤ 20%), ring goes red.
      expect(badge.getAttribute('data-tone')).toBe('critical');
    });
  });

  it('codex 5h=100%/周=50% leaves the ring unchanged (weekly slack)', async () => {
    // weekly_as_5h = 50 / 0.28 ≈ 178 → clamp to 100 → effective = min(100, 100) = 100.
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'codex',
          accountLabel: 'Codex',
          windows: [
            { name: '5h',     percentLeft: 100, resetAt: Date.now(), windowSeconds: 18_000 },
            { name: 'weekly', percentLeft: 50,  resetAt: Date.now(), windowSeconds: 604_800 },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();
    await waitFor(() => {
      const badge = screen.getByLabelText('Codex · 5h 100% · 周 50% · 实际 100%');
      expect(badge.getAttribute('data-tone')).toBe('ok');
    });
  });

  it('claude-code uses ratio 0.10 (Anthropic Pro/Max telemetry)', async () => {
    // weekly=10% / 0.10 = 100 → effective stays at 100.
    // weekly=5%  / 0.10 = 50  → effective drops to 50, warn tone.
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'claude-code',
          accountLabel: 'Claude',
          windows: [
            { name: '5h',     percentLeft: 100, resetAt: Date.now(), windowSeconds: 18_000 },
            { name: 'weekly', percentLeft: 5,   resetAt: Date.now(), windowSeconds: 604_800 },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();
    await waitFor(() => {
      const badge = screen.getByLabelText('Claude · 5h 100% · 周 5% · 实际 50%');
      expect(badge.getAttribute('data-tone')).toBe('warn');
    });
  });

  it('opencode uses ratio 0.40 (dollar-based: $12/$30)', async () => {
    // weekly=30% / 0.40 = 75 → effective = min(5h=100, 75) = 75, ok.
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'opencode',
          accountLabel: 'OpenCode',
          windows: [
            { name: 'opencode-5h', percentLeft: 100, resetAt: Date.now(), windowSeconds: 18_000 },
            { name: 'opencode-7d', percentLeft: 30,  resetAt: Date.now(), windowSeconds: 604_800 },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();
    await waitFor(() => {
      const badge = screen.getByLabelText('OpenCode · 5h 100% · 周 30% · 实际 75%');
      expect(badge.getAttribute('data-tone')).toBe('ok');
    });
  });

  it('5h is the binding constraint when 5h is the lower side', async () => {
    // 5h=18% / weekly=80% (codex, ratio 0.28)
    // weekly_as_5h = 80 / 0.28 ≈ 286 → clamped 100
    // effective = min(18, 100) = 18, critical
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'codex',
          accountLabel: 'Codex',
          windows: [
            { name: '5h',     percentLeft: 18, resetAt: Date.now(), windowSeconds: 18_000 },
            { name: 'weekly', percentLeft: 80, resetAt: Date.now(), windowSeconds: 604_800 },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();
    await waitFor(() => {
      const badge = screen.getByLabelText('Codex · 5h 18% · 周 80% · 实际 18%');
      expect(badge.getAttribute('data-tone')).toBe('critical');
    });
  });

  it('AND-coupled providers degrade gracefully when one window is missing', async () => {
    // Only weekly available: trust weekly→5h scaling.
    // weekly=70% / 0.28 = 250 → clamp 100. Effective 100, ok.
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'codex',
          accountLabel: 'Codex',
          windows: [
            { name: 'weekly', percentLeft: 70, resetAt: Date.now(), windowSeconds: 604_800 },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();
    await waitFor(() => {
      // No 5h reading → tooltip omits the 5h segment but keeps weekly.
      const badge = screen.getByLabelText('Codex · 周 70% · 实际 100%');
      expect(badge.getAttribute('data-tone')).toBe('ok');
    });
  });

  it('aggregates multi-window providers using average value (non-AND-coupled)', async () => {
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'gemini-cli',
          accountLabel: 'Gemini CLI Label',
          windows: [
            { name: 'gemini-3.1-pro',        percentLeft: 60, resetAt: Date.now(), windowSeconds: null },
            { name: 'gemini-3.1-flash-lite', percentLeft: 80, resetAt: Date.now(), windowSeconds: null },
          ],
        }),
        snapshot({
          provider: 'antigravity',
          accountLabel: 'Antigravity Label',
          windows: [
            { name: 'MODEL_CLAUDE_OPUS_4_6',       percentLeft: 30, resetAt: Date.now(), windowSeconds: null },
            { name: 'MODEL_GOOGLE_GEMINI_3_1_PRO', percentLeft: 50, resetAt: Date.now(), windowSeconds: null },
            { name: 'MODEL_CHAT_23310',            percentLeft: 70, resetAt: Date.now(), windowSeconds: null },
          ],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();
    await waitFor(() => {
      // average: (60 + 80) / 2 = 70%
      expect(screen.getByLabelText('Gemini CLI Label · 70%')).toBeTruthy();
      // average: (30 + 50) / 2 = 40% (MODEL_CHAT_23310 is filtered by display map)
      expect(screen.getByLabelText('Antigravity Label · 40%')).toBeTruthy();
    });
  });

  it('renders xiaomi only when it has valid percentage data', async () => {
    installDesktopBridge({
      snapshots: [
        snapshot({
          provider: 'xiaomi',
          accountLabel: '小米账号',
          windows: [],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    await waitFor(() => {
      expect(screen.queryByLabelText(/小米/)).toBeNull();
    });

    cleanup();

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
          windows: [{ name: '5h', percentLeft: 80, resetAt: Date.now(), windowSeconds: 18_000 }],
        }),
      ],
    });

    render(<CompactMiniRail state={mockDashboardState()} />);
    expect(await screen.findByTestId('compact-mini-rail')).toBeTruthy();

    await waitFor(() => {
      const providers = document.querySelectorAll('.compact-mini-rail__provider');
      expect(providers).toHaveLength(4);
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
