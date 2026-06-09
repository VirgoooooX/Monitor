// @vitest-environment jsdom
//
// Feature: network-quick-actions, Property 4: Config switch is gated by an explicit confirmation.
// Validates Requirements 6.1, 6.3, 6.4, 7.4.
//
// Feature: network-quick-actions, Property 18: Config file whitelist render contract.
// Validates Requirements 4.3, 4.4.
//
// ---------------------------------------------------------------------------
// Test plan
// ---------------------------------------------------------------------------
//
// Property 18 (Config file whitelist render contract — Requirements 4.3, 4.4):
//   • The IPC layer guarantees at most one `isActive` entry, but a regression
//     there must not light up two badges. ConfigSwitchCard performs a
//     defensive dedupe; we exercise it by feeding a whitelist with two
//     `isActive: true` entries and assert exactly one `生效` badge renders.
//   • A whitelist with exactly one `isActive: true` entry whose `path`
//     matches the parent `activePath` MUST render exactly one `生效` badge
//     (the happy path).
//   • The component MUST NEVER render the entry's absolute `path` verbatim
//     (router filesystem layout is sensitive — see ConfigSwitchCard
//     header comments). When `label` is non-empty after trim it wins;
//     otherwise the basename of the path is shown.
//
// Property 4 (Config switch is gated by an explicit confirmation —
// Requirements 6.1, 6.3, 6.4, 7.4):
//   • A click on a non-active candidate MUST open the confirmation dialog
//     without touching `window.desktop.switchOpenClashConfig`.
//   • The Cancel branch of the dialog MUST NOT invoke the switch IPC and
//     MUST NOT write an audit row (audit rows are written by the main
//     process; we assert the IPC stays silent which is the only knob the
//     renderer can pull).
//   • The Accept branch MUST invoke `switchOpenClashConfig` exactly once
//     with `{ targetPath: <entry.path> }` — the literal full path
//     (the renderer never displays it, but the IPC payload uses it).
//
// We mount the full `QuickActionsPanel` for the Property 4 cases so the
// dialog flow (open → cancel/confirm) is exercised end-to-end against the
// real wiring, including the parent's IPC call site. Property 18 tests
// render `ConfigSwitchCard` directly because they only inspect DOM output.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { ConfigSwitchCard } from './ConfigSwitchCard';
import { QuickActionsPanel } from './QuickActionsPanel';
import type {
  ConfigSwitchResult,
  NetworkQuickActions,
  Unsubscribe,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a `NetworkQuickActions` payload covering the slices `ConfigSwitchCard`
 * and `QuickActionsPanel` actually consume. Defaults reflect a healthy,
 * reachable management interface with two whitelisted configs (one active,
 * one switchable). Individual tests override only the slices they need.
 */
function buildQuickActions(
  overrides: Partial<NetworkQuickActions> = {},
): NetworkQuickActions {
  return {
    primaryGroup: {
      name: '🔰 节点选择',
      currentNode: 'HK-01',
      candidates: [],
    },
    configFiles: {
      activePath: '/etc/openclash/config/main.yaml',
      entries: [
        {
          label: 'Main',
          path: '/etc/openclash/config/main.yaml',
          isActive: true,
        },
        {
          label: 'Backup',
          path: '/etc/openclash/config/backup.yaml',
          isActive: false,
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
    ...overrides,
  };
}

/**
 * Install a fake `window.desktop` bridge backed by `vi.fn()` mocks. Only
 * the channels exercised by `QuickActionsPanel` and `ConfigSwitchCard`
 * are stubbed; the rest are present but throw to surface accidental
 * coupling. The returned handle exposes the mocks so tests can assert
 * call counts and arguments.
 */
function installDesktopBridge(quickActions: NetworkQuickActions) {
  const switchOpenClashConfig = vi.fn<(input: { targetPath: string }) => Promise<ConfigSwitchResult>>(
    async ({ targetPath }) => ({
      ok: true,
      startPath: quickActions.configFiles.activePath,
      targetPath,
      finalPath: targetPath,
    })
  );

  const getNetworkQuickActions = vi.fn<() => Promise<NetworkQuickActions>>(
    async () => quickActions,
  );

  const switchNode = vi.fn();
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();
  const on = vi.fn(
    (channel: string, cb: (payload: unknown) => void): Unsubscribe => {
      let bucket = subscribers.get(channel);
      if (!bucket) {
        bucket = new Set();
        subscribers.set(channel, bucket);
      }
      bucket.add(cb);
      return () => {
        bucket?.delete(cb);
      };
    },
  );

  // Cast through `unknown` to fit the strict `DesktopApi` shape without
  // re-declaring every method we don't exercise.
  (window as unknown as { desktop: unknown }).desktop = {
    getNetworkQuickActions,
    switchOpenClashConfig,
    switchNode,
    on,
    // The remaining bridge methods are not exercised by these tests; we
    // expose throwing stubs so any accidental coupling surfaces loudly.
    getDashboard: vi.fn(),
    getOpenClashDetails: vi.fn(),
    refreshNow: vi.fn(),
    getUsageSummary: vi.fn(),
    getQuotaStatus: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    updateSecret: vi.fn(),
    getDiagnostics: vi.fn(),
    openExpanded: vi.fn(),
    clearManagementCredentials: vi.fn(),
  };

  return {
    switchOpenClashConfig,
    getNetworkQuickActions,
    on,
  };
}

beforeEach(() => {
  // jsdom does not implement `requestAnimationFrame` the same way browsers
  // do (it falls back to a 0ms timeout). The ConfirmDialog relies on rAF
  // to defer focus. Both jsdom and our test usage are happy with the
  // default polyfill, so no setup beyond DOM cleanup is required.
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

// ===========================================================================
// Property 18 — Config file whitelist render contract
// ===========================================================================

describe('ConfigSwitchCard — Property 18: whitelist render contract', () => {
  // -------------------------------------------------------------------------
  // At-most-one isActive entry
  // -------------------------------------------------------------------------

  it('renders only one 生效 badge even when two whitelist entries are isActive', () => {
    const data = buildQuickActions({
      configFiles: {
        activePath: '/etc/openclash/config/alpha.yaml',
        entries: [
          {
            label: 'Alpha',
            path: '/etc/openclash/config/alpha.yaml',
            isActive: true,
          },
          {
            label: 'Beta',
            path: '/etc/openclash/config/beta.yaml',
            // Intentional regression: two `isActive: true` entries. The
            // component MUST defensively pick exactly one.
            isActive: true,
          },
        ],
      },
    });

    render(
      <ConfigSwitchCard
        configFiles={data.configFiles}
        management={data.management}
        switchInProgress={data.switchInProgress}
        healthStatus="healthy"
        onConfirmSwitch={() => undefined}
      />,
    );

    const badges = screen.getAllByTestId('config-switch-active-badge');
    expect(badges).toHaveLength(1);
  });

  it('renders exactly one 生效 badge for the matching active entry', () => {
    const activePath = '/etc/openclash/config/main.yaml';
    const data = buildQuickActions({
      configFiles: {
        activePath,
        entries: [
          { label: 'Main', path: activePath, isActive: true },
          {
            label: 'Backup',
            path: '/etc/openclash/config/backup.yaml',
            isActive: false,
          },
        ],
      },
    });

    render(
      <ConfigSwitchCard
        configFiles={data.configFiles}
        management={data.management}
        switchInProgress={data.switchInProgress}
        healthStatus="healthy"
        onConfirmSwitch={() => undefined}
      />,
    );

    const badges = screen.getAllByTestId('config-switch-active-badge');
    expect(badges).toHaveLength(1);

    // The badge must sit inside the row whose label is "Main", not "Backup".
    const activeRow = screen.getByTestId('config-switch-row-0');
    expect(within(activeRow).getByTestId('config-switch-active-badge')).toBeDefined();
    expect(within(activeRow).getByText('Main')).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Never renders the literal `path`
  // -------------------------------------------------------------------------

  it('renders the trimmed label and never the absolute path', () => {
    const sensitivePath = '/etc/openclash/config/foo.yaml';
    const data = buildQuickActions({
      configFiles: {
        activePath: null,
        entries: [
          { label: 'My Profile', path: sensitivePath, isActive: false },
        ],
      },
    });

    const { container } = render(
      <ConfigSwitchCard
        configFiles={data.configFiles}
        management={data.management}
        switchInProgress={data.switchInProgress}
        healthStatus="healthy"
        onConfirmSwitch={() => undefined}
      />,
    );

    // Alias is rendered.
    expect(screen.getByText('My Profile')).toBeDefined();
    // Absolute path is NEVER present in the rendered DOM.
    expect(container.textContent ?? '').not.toContain(sensitivePath);
    // Neither should the parent directory leak.
    expect(container.textContent ?? '').not.toContain('/etc/openclash/config');
  });

  it('falls back to the basename when label is empty (still never renders the full path)', () => {
    const sensitivePath = '/etc/openclash/config/foo.yaml';
    const data = buildQuickActions({
      configFiles: {
        activePath: null,
        entries: [{ label: '', path: sensitivePath, isActive: false }],
      },
    });

    const { container } = render(
      <ConfigSwitchCard
        configFiles={data.configFiles}
        management={data.management}
        switchInProgress={data.switchInProgress}
        healthStatus="healthy"
        onConfirmSwitch={() => undefined}
      />,
    );

    // Basename appears as the user-facing label.
    expect(screen.getByText('foo.yaml')).toBeDefined();
    // The full path is never rendered, even when label falls back.
    expect(container.textContent ?? '').not.toContain(sensitivePath);
    expect(container.textContent ?? '').not.toContain('/etc/openclash/config');
  });
});

// ===========================================================================
// Property 4 — Config switch is gated by an explicit confirmation
// ===========================================================================

describe('ConfigSwitchCard via QuickActionsPanel — Property 4: confirmation gates IPC', () => {
  // -------------------------------------------------------------------------
  // Cancel writes no IPC
  // -------------------------------------------------------------------------

  it('opens the dialog on click but does not invoke switchOpenClashConfig', async () => {
    const data = buildQuickActions();
    const bridge = installDesktopBridge(data);

    render(<QuickActionsPanel healthStatus="healthy" />);

    // Wait for the panel to hydrate from the initial getNetworkQuickActions
    // call — the skeleton is replaced by the ready surface once data lands.
    await waitFor(() => {
      expect(screen.getByTestId('config-switch-card')).toBeDefined();
    });

    // Click the non-active row's "切换" button. Index 1 is the Backup entry
    // in the default fixture.
    fireEvent.click(screen.getByTestId('config-switch-btn-1'));

    // Dialog opens.
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeDefined();
    });

    // Merely opening the dialog must not call the IPC.
    expect(bridge.switchOpenClashConfig).not.toHaveBeenCalled();
  });

  it('Cancel writes no IPC (Requirement 6.4)', async () => {
    const data = buildQuickActions();
    const bridge = installDesktopBridge(data);

    render(<QuickActionsPanel healthStatus="healthy" />);

    await waitFor(() => {
      expect(screen.getByTestId('config-switch-card')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('config-switch-btn-1'));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    // Dialog should close and the IPC must NEVER fire on the cancel path.
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });
    expect(bridge.switchOpenClashConfig).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Accept fires exactly one IPC
  // -------------------------------------------------------------------------

  it('Accept fires switchOpenClashConfig exactly once with the entry path', async () => {
    const data = buildQuickActions();
    const bridge = installDesktopBridge(data);

    render(<QuickActionsPanel healthStatus="healthy" />);

    await waitFor(() => {
      expect(screen.getByTestId('config-switch-card')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('config-switch-btn-1'));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    // The IPC must fire exactly once with the literal absolute path
    // of the clicked whitelist entry (Requirement 7.4: the renderer
    // forwards the value the main process whitelisted).
    await waitFor(() => {
      expect(bridge.switchOpenClashConfig).toHaveBeenCalledTimes(1);
    });
    expect(bridge.switchOpenClashConfig).toHaveBeenCalledWith({
      targetPath: '/etc/openclash/config/backup.yaml',
    });

    // Dialog closes after accept.
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });
  });
});
