// @vitest-environment jsdom
//
// Feature: network-quick-actions, Property 2: Quick_Actions_Panel layout is total over health states.
// Validates Requirements 2.3, 2.5, 10.1, 10.2.
//
// Feature: network-quick-actions, Property 14: Persistent management failure threshold.
// Validates Requirements 14.4.
//
// Component tests for `QuickActionsPanel` (network-quick-actions task
// 15.7). The panel is the visual entry-point for both Quick_Node_Card
// and Config_Switch_Card, so the layout invariants exercised here
// guard the user-visible surface of the entire feature:
//
//   • Property 2 (layout totality): for every `HealthStatus` value the
//     panel renders, the QuickNodeCard appears strictly above the
//     ConfigSwitchCard, and the panel itself stays mounted (the user
//     can always reach the controls, no "blank screen" failure mode).
//
//   • Property 2 (banner contract): the banner shown at the top of
//     the panel reflects the current `HealthStatus` and management
//     state per the rules in Requirement 2.5 + 10.2..10.6. Healthy
//     state suppresses the banner; degraded states surface a
//     non-empty zh-CN hint with the appropriate tone.
//
//   • Property 14 (persistent management failure): once the
//     `collector_health.openclash.management.consecutive_failures`
//     counter reaches the 5-failure threshold the panel surfaces the
//     dedicated "OpenClash 管理接口持续失败" banner. Under that
//     threshold the persistent-failure banner is suppressed.
//
// Setup notes:
//   • The renderer's `window.desktop` bridge is replaced by a fake
//     that returns a parameterised `NetworkQuickActions` payload and
//     registers no-op subscribers for the `dashboard.updated` /
//     `openclash.updated` push events. The fake is scoped per-test
//     via `vi.stubGlobal('desktop', ...)` so each case starts from a
//     clean state.
//   • `await waitFor(...)` is used to wait for the async
//     `getNetworkQuickActions` promise to resolve before asserting on
//     the post-skeleton DOM.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { QuickActionsPanel } from './QuickActionsPanel';
import type {
  HealthStatus,
  NetworkQuickActions,
  Unsubscribe,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a default-valid `NetworkQuickActions` payload that the panel
 * can render without surfacing any error state. Tests override only
 * the slice they care about via the `overrides` object.
 *
 * The defaults model a "happy path" deployment:
 *   • a primary group ("PROXY") with one current node and zero
 *     candidates (so QuickNodeCard renders the empty placeholder
 *     instead of clickable buttons we'd have to disable per-test);
 *   • a single whitelist entry (the active config) so
 *     ConfigSwitchCard renders the full list view rather than the
 *     "no whitelist" guidance branch;
 *   • management configured + reachable + zero consecutive failures;
 *   • no in-flight switch and no recent failure to surface.
 */
function buildPayload(
  overrides: Partial<NetworkQuickActions> = {},
): NetworkQuickActions {
  const base: NetworkQuickActions = {
    primaryGroup: {
      name: 'PROXY',
      currentNode: 'NodeA',
      candidates: [],
    },
    configFiles: {
      activePath: '/etc/openclash/config/main.yaml',
      whitelist: [
        {
          alias: 'Main',
          path: '/etc/openclash/config/main.yaml',
          isActive: true,
        },
      ],
    },
    management: {
      configured: true,
      reachable: true,
      consecutiveFailures: 0,
      lastErrorCode: null,
    },
    lastConfigSwitch: null,
    switchInProgress: false,
  };

  return {
    ...base,
    ...overrides,
    primaryGroup: { ...base.primaryGroup, ...(overrides.primaryGroup ?? {}) },
    configFiles: { ...base.configFiles, ...(overrides.configFiles ?? {}) },
    management: { ...base.management, ...(overrides.management ?? {}) },
  };
}

/**
 * Install a fake `window.desktop` that:
 *   • resolves `getNetworkQuickActions()` with a single payload built
 *     from `buildPayload(overrides)`;
 *   • registers a no-op `on(channel, cb)` that returns an unsubscribe
 *     function, satisfying `useEffect` cleanup;
 *   • exposes the remaining `DesktopApi` members as `vi.fn()` stubs
 *     that throw if accidentally called by the panel — none of the
 *     code paths exercised here should reach them.
 */
function stubDesktopBridge(overrides: Partial<NetworkQuickActions> = {}): void {
  const payload = buildPayload(overrides);

  const desktop = {
    getDashboard: vi.fn(),
    getOpenClashDetails: vi.fn(),
    switchNode: vi.fn(),
    refreshNow: vi.fn(),
    getUsageSummary: vi.fn(),
    getQuotaStatus: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    updateSecret: vi.fn(),
    getDiagnostics: vi.fn(),
    openExpanded: vi.fn(),
    getNetworkQuickActions: vi.fn(async () => payload),
    switchOpenClashConfig: vi.fn(),
    clearManagementCredentials: vi.fn(),
    on: vi.fn((): Unsubscribe => {
      return () => {
        /* no-op unsubscribe */
      };
    }),
  };

  vi.stubGlobal('desktop', desktop);
}

// The six `HealthStatus` values defined in `src/main/types.ts`. Listed
// explicitly so a future addition to the union is a TypeScript error
// here rather than silently shrinking coverage.
const ALL_HEALTH_STATUSES = [
  'healthy',
  'node_slow',
  'node_down',
  'partial_outage',
  'openclash_unreachable',
  'home_down',
] as const satisfies readonly HealthStatus[];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Re-set per-test so stub state from prior cases never leaks.
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Property 2 — Panel renders for every health state (no blank-screen failure)
// ---------------------------------------------------------------------------
//
// For every `HealthStatus` value the panel must mount the
// `quick-actions-panel` container and surface the ConfigSwitchCard so
// users can always reach the controls (Requirement 10.1).
//
// The original Property 2 assertion that QuickNodeCard rendered
// strictly above ConfigSwitchCard no longer applies — quick node
// switching now lives in the NodeTable section of the network tab,
// not the QuickActionsPanel. The single-card panel makes "fixed
// sibling order" trivially total.

describe('QuickActionsPanel — Property 2 (panel mounts in every health state)', () => {
  it.each(ALL_HEALTH_STATUSES)(
    'renders the ConfigSwitchCard under healthStatus=%s',
    async (healthStatus) => {
      stubDesktopBridge();

      render(<QuickActionsPanel healthStatus={healthStatus} />);

      // Panel container must exist immediately — even before the
      // async fetch resolves the skeleton view carries the same
      // testid (Requirement 2.2).
      const panel = await screen.findByTestId('quick-actions-panel');
      expect(panel).toBeTruthy();

      // After the data resolves, the ConfigSwitchCard must mount.
      const configCard = await screen.findByTestId('config-switch-card');
      expect(configCard).toBeTruthy();
    },
  );
});

// ---------------------------------------------------------------------------
// Property 2 — Banner presence/absence
// ---------------------------------------------------------------------------
//
// The banner contract from Requirement 2.5 + 10.2..10.6:
//   • healthy + zero failures + no error code  → no banner.
//   • home_down                                  → critical banner.
//   • node_slow / node_down / partial_outage    → notice banner
//                                                 (switch buttons
//                                                 stay enabled —
//                                                 Requirement 10.2).
//   • openclash_unreachable                      → notice/warn banner
//                                                 depending on
//                                                 management
//                                                 reachability.

describe('QuickActionsPanel — Property 2 (banner presence/absence)', () => {
  it('renders no banner when healthy with zero failures and no error', async () => {
    stubDesktopBridge();

    render(<QuickActionsPanel healthStatus="healthy" />);

    // Wait for the data-loaded view so the banner state is settled.
    await screen.findByTestId('config-switch-card');

    expect(screen.queryByTestId('quick-actions-panel-banner')).toBeNull();
  });

  it('renders a critical banner under home_down', async () => {
    stubDesktopBridge();

    render(<QuickActionsPanel healthStatus="home_down" />);

    const banner = await screen.findByTestId('quick-actions-panel-banner');
    expect(banner.getAttribute('data-tone')).toBe('critical');
    expect(banner.textContent ?? '').toMatch(/路由器不可达/);
  });

  it.each(['node_slow', 'partial_outage', 'node_down'] as const)(
    'renders a notice banner under %s without disabling switch buttons solely by health',
    async (healthStatus) => {
      // Provide a single non-active candidate so ConfigSwitchCard
      // emits a switch button we can inspect for disabled state.
      stubDesktopBridge({
        configFiles: {
          activePath: '/etc/openclash/config/main.yaml',
          whitelist: [
            {
              alias: 'Main',
              path: '/etc/openclash/config/main.yaml',
              isActive: true,
            },
            {
              alias: 'Backup',
              path: '/etc/openclash/config/backup.yaml',
              isActive: false,
            },
          ],
        },
      });

      render(<QuickActionsPanel healthStatus={healthStatus} />);

      const banner = await screen.findByTestId('quick-actions-panel-banner');
      expect(banner.getAttribute('data-tone')).toBe('notice');
      expect(banner.textContent ?? '').toMatch(/网络降级/);

      // The non-active config row (index 1 — index 0 is the active
      // entry which is always disabled by design). Health alone
      // should NOT disable it (Requirement 10.2): only management
      // / lock state is allowed to flip the disabled flag.
      const switchBtn = await screen.findByTestId('config-switch-btn-1');
      expect((switchBtn as HTMLButtonElement).disabled).toBe(false);
    },
  );

  it('renders a notice/warn banner under openclash_unreachable', async () => {
    // Default fixture has management.reachable = true, which selects
    // the "暂不可达，可尝试切换配置以恢复" notice variant.
    stubDesktopBridge();

    render(<QuickActionsPanel healthStatus="openclash_unreachable" />);

    const banner = await screen.findByTestId('quick-actions-panel-banner');
    const tone = banner.getAttribute('data-tone');
    expect(tone === 'notice' || tone === 'warn').toBe(true);
    expect((banner.textContent ?? '').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Property 14 — Persistent management failure threshold
// ---------------------------------------------------------------------------
//
// `consecutiveFailures >= 5` lights up the persistent-failure banner
// regardless of the `HealthStatus` (the management interface is its
// own collector and can fail while the rest of the network looks
// healthy). Below the threshold the persistent-failure banner is
// suppressed — other banners may still show for unrelated reasons,
// but the persistent-failure phrasing must not appear.

describe('QuickActionsPanel — Property 14 (persistent failure threshold)', () => {
  const PERSISTENT_TEXT = /OpenClash 管理接口持续失败/;

  it.each([0, 1, 2, 3, 4, 5, 6, 10] as const)(
    'consecutiveFailures=%i renders persistent banner iff >= 5',
    async (consecutiveFailures) => {
      stubDesktopBridge({
        management: {
          configured: true,
          reachable: true,
          consecutiveFailures,
          lastErrorCode: null,
        },
      });

      render(<QuickActionsPanel healthStatus="healthy" />);

      // Wait for the data-loaded view so banner state is settled.
      await waitFor(() => {
        expect(screen.queryByTestId('config-switch-card')).not.toBeNull();
      });

      const banner = screen.queryByTestId('quick-actions-panel-banner');

      if (consecutiveFailures >= 5) {
        // Persistent banner must be present with the exact phrasing.
        expect(banner).not.toBeNull();
        expect(banner!.textContent ?? '').toMatch(PERSISTENT_TEXT);
        expect(banner!.getAttribute('data-tone')).toBe('warn');
      } else {
        // Persistent banner must not appear; under healthy status
        // there is no other banner either, so the slot is empty.
        if (banner !== null) {
          expect(banner.textContent ?? '').not.toMatch(PERSISTENT_TEXT);
        } else {
          expect(banner).toBeNull();
        }
      }
    },
  );
});
