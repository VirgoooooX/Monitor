// @vitest-environment jsdom
//
// Feature: cpa-quota-import, Renderer Provider_Auth integration (task 12.4).
// Validates Requirements 12.2, 12.3, 12.4, 12.5.
//
// End-to-end-ish tests for the Provider_Auth section of `SettingsView`.
// These cases exercise the full renderer surface — `SettingsView`
// loads settings + provider_auth rows on mount, the user clicks
// Refresh / Delete, and the integration test asserts that the
// matching `desktop.*` IPC method is invoked with the documented
// payload.
//
// The test also smoke-renders the settings sections (appearance /
// controller / probes / groups / router / intervals / switching /
// management / collectors). Provider_Auth now lives inside the
// Collectors section so the settings rail does not duplicate the
// "AI source" concept.
//
// We mock `window.desktop` with `vi.stubGlobal` so the cleanup in
// `afterEach` is total. Every IPC method the component touches is a
// `vi.fn()` — the unused ones are present so any accidental coupling
// fails loudly with "<method> is not a function" instead of silently
// resolving with `undefined`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { SettingsView } from './SettingsView';
import type {
  AppSettings,
  ProviderAuthMetadata,
  ProviderId,
  QuotaCapability,
  ProviderAuthErrorCode,
  Unsubscribe,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Settings fixture
// ---------------------------------------------------------------------------

/**
 * Build a complete `AppSettings` blob that satisfies the renderer's
 * client-side validation. Mirrors the shape of `buildDefaultAppSettings`
 * in `src/main/app.ts` so a future field added to the schema will
 * surface here as a TypeScript error rather than as a silent runtime
 * blank-screen failure.
 */
function buildAppSettings(): AppSettings {
  return {
    controllerUrl: 'http://192.168.31.100:9090',
    primaryGroups: ['🚀 节点选择', '🔮 默认'],
    probeUrls: [
      'https://www.google.com/generate_204',
      'https://www.gstatic.com/generate_204',
    ],
    routerHealth: { host: '192.168.31.100', port: 22 },
    switchVerifyDelayMs: 1000,
    switchConfirmation: false,
    refreshIntervals: {
      networkMs: 3_000,
      openclashMs: 3_000,
      currentNodeMs: 10_000,
      nodeScanMs: 60_000,
      usageMs: 60_000,
      retentionMs: 60 * 60 * 1_000,
    },
    collectors: {
      codex: { enabled: true },
      gemini: { enabled: true },
      antigravity: { enabled: false },
      opencode: { enabled: false },
      deepseek: { enabled: false },
    },
    cliproxy: {
      enabled: false,
      managementUrl: '',
      authDir: '',
      usageQueueBatchSize: 25,
    },
    autostart: false,
    configSwitchVerifyWindowMs: 8_000,
    managementInterface: {
      kind: 'openclash-luci',
      url: '',
      requestTimeoutMs: 10_000,
      configFileWhitelist: [],
    },
    appearance: {
      colorMode: 'dark',
      compactTheme: 'mint-monitor',
      fontScale: 1,
      compactZoom: 1,
    },
    kiroTokenRefresh: {
      enabled: true,
      writeBackAuthFile: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider_Auth fixture
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<ProviderAuthMetadata> = {},
): ProviderAuthMetadata {
  const base: ProviderAuthMetadata = {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'codex' as ProviderId,
    label: 'codex@example.com',
    source: 'cpa-auth-file',
    accountId: 'acct-123',
    projectId: null,
    quotaCapability: 'official' as QuotaCapability,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastValidatedAt: 1_700_000_000_000,
    lastQuotaAt: 1_700_000_000_000,
    lastErrorCode: null,
    lastErrorMessage: null,
    enabled: true,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Desktop bridge stub
// ---------------------------------------------------------------------------

interface BridgeOverrides {
  readonly providerAuthRows?: ReadonlyArray<ProviderAuthMetadata>;
  readonly listProviderAuths?: () => Promise<ProviderAuthMetadata[]>;
  readonly refreshProviderQuota?: ReturnType<typeof vi.fn>;
  readonly deleteProviderAuth?: ReturnType<typeof vi.fn>;
  readonly importProviderAuthFile?: ReturnType<typeof vi.fn>;
  readonly validateProviderAuth?: ReturnType<typeof vi.fn>;
}

/**
 * Install a `window.desktop` whose Provider_Auth methods are
 * controlled per-test. The remaining `DesktopApi` methods are stubbed
 * with `vi.fn()` so any unexpected call fails an assertion in the
 * stubbing test rather than throwing a "not a function" runtime
 * error from inside the component.
 *
 * The returned object exposes the relevant Provider_Auth mocks so
 * tests can assert call counts and arguments. We use `vi.stubGlobal`
 * (rather than direct assignment) so `vi.unstubAllGlobals` in
 * `afterEach` cleans up totally between cases.
 */
function installDesktopBridge(overrides: BridgeOverrides = {}) {
  const initialRows = overrides.providerAuthRows ?? [];

  // The list is held in a closure so subsequent `listProviderAuths`
  // calls (e.g. from `handleProviderAuthRefresh`'s re-fetch) reflect
  // any in-test mutations.
  let currentRows: ProviderAuthMetadata[] = [...initialRows];

  const listProviderAuths = vi.fn(
    overrides.listProviderAuths ?? (async () => [...currentRows]),
  );

  const refreshProviderQuota =
    overrides.refreshProviderQuota ??
    vi.fn(async () => ({ snapshots: [] }));

  const deleteProviderAuth =
    overrides.deleteProviderAuth ??
    vi.fn(async (input: { id: string }) => {
      currentRows = currentRows.filter((r) => r.id !== input.id);
      return undefined;
    });

  const importProviderAuthFile =
    overrides.importProviderAuthFile ?? vi.fn();

  const validateProviderAuth =
    overrides.validateProviderAuth ?? vi.fn();

  const desktop = {
    getDashboard: vi.fn(),
    getOpenClashDetails: vi.fn(),
    switchNode: vi.fn(),
    refreshNow: vi.fn(),
    getUsageSummary: vi.fn(),
    getQuotaStatus: vi.fn(),
    getSettings: vi.fn(async () => buildAppSettings()),
    updateSettings: vi.fn(),
    updateSecret: vi.fn(),
    getDiagnostics: vi.fn(),
    openExpanded: vi.fn(),
    getNetworkQuickActions: vi.fn(),
    switchOpenClashConfig: vi.fn(),
    clearManagementCredentials: vi.fn(),
    listProviderAuths,
    importProviderAuthFile,
    deleteProviderAuth,
    refreshProviderQuota,
    validateProviderAuth,
    on: vi.fn((): Unsubscribe => () => {
      /* no-op unsubscribe */
    }),
  };

  vi.stubGlobal('desktop', desktop);

  return {
    listProviderAuths,
    importProviderAuthFile,
    deleteProviderAuth,
    refreshProviderQuota,
    validateProviderAuth,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===========================================================================
// Smoke render — Requirement 12.1: adding Provider_Auth must NOT break the
// existing eight sections.
// ===========================================================================

describe('SettingsView Provider_Auth — smoke render', () => {
  it('renders the settings sections with Provider_Auth inside the AI Accounts panel', async () => {
    installDesktopBridge();

    render(<SettingsView />);

    // Wait for the initial settings load to settle. Once `loading`
    // flips to `false` the form mounts and every section's DOM id
    // is reachable.
    await waitFor(() => {
      expect(document.getElementById('settings-section-controller')).not.toBeNull();
    });

    // The top-level settings sections must all be present after the
    // load finishes.
    expect(document.getElementById('settings-section-appearance')).not.toBeNull();
    expect(document.getElementById('settings-section-controller')).not.toBeNull();
    expect(document.getElementById('settings-section-probes')).not.toBeNull();
    expect(document.getElementById('settings-section-groups')).not.toBeNull();
    expect(document.getElementById('settings-section-router')).not.toBeNull();
    expect(document.getElementById('settings-section-intervals')).not.toBeNull();
    expect(document.getElementById('settings-section-switching')).not.toBeNull();
    expect(document.getElementById('settings-section-management')).not.toBeNull();
    // The 8th rail entry was renamed from `collectors` (legacy) to
    // `accounts` (AI Accounts unification). The hardcoded provider
    // toggles disappeared with the rename.
    expect(document.getElementById('settings-section-accounts')).not.toBeNull();
    expect(document.getElementById('settings-section-collectors')).toBeNull();

    // Provider_Auth lives inside the AI Accounts section, not as a
    // separate rail item.
    expect(document.getElementById('settings-section-provider-auth')).toBeNull();
    expect(screen.getByTestId('provider-auth-import')).toBeDefined();
  });

  it('renders the empty-state copy for provider-auth when listProviderAuths returns []', async () => {
    installDesktopBridge({ providerAuthRows: [] });

    render(<SettingsView />);

    // The empty-state lives inside `ProviderAuthList`. Its
    // `data-testid` is stable across the section's rendering tree
    // so we can target it directly without scanning copy.
    await waitFor(() => {
      expect(screen.getByTestId('provider-auth-list-empty')).toBeDefined();
    });

    expect(screen.getByTestId('provider-auth-list-empty').textContent ?? '')
      .toMatch(/尚未导入/);
  });

  it('does not show a red error when the import file picker is cancelled', async () => {
    const importProviderAuthFile = vi.fn(async () => {
      throw { code: 'cancelled', message: 'user cancelled file selection' };
    });
    installDesktopBridge({ importProviderAuthFile });

    render(<SettingsView />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-auth-import')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('provider-auth-import'));

    await waitFor(() => {
      expect(importProviderAuthFile).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('provider-auth-error')).toBeNull();
    });
  });
});

// ===========================================================================
// listProviderAuths populates rows on mount — Requirement 12.2.
// ===========================================================================

describe('SettingsView Provider_Auth — initial load', () => {
  it('populates rows from the mocked listProviderAuths IPC on mount', async () => {
    const row = makeRow();
    const { listProviderAuths } = installDesktopBridge({
      providerAuthRows: [row],
    });

    render(<SettingsView />);

    await waitFor(() => {
      expect(
        screen.getByTestId(`provider-auth-list-row-${row.id}`),
      ).toBeDefined();
    });

    expect(listProviderAuths).toHaveBeenCalledTimes(1);

    // Both Refresh and Delete buttons must be rendered for the row.
    expect(
      screen.getByTestId(`provider-auth-list-row-${row.id}-refresh`),
    ).toBeDefined();
    expect(
      screen.getByTestId(`provider-auth-list-row-${row.id}-delete`),
    ).toBeDefined();
  });
});

// ===========================================================================
// Refresh click — Requirement 12.5: clicking Refresh calls
// `desktop.refreshProviderQuota({ id })` and disables the button while
// the IPC is in flight.
// ===========================================================================

describe('SettingsView Provider_Auth — Refresh click', () => {
  it('calls desktop.refreshProviderQuota({ id }) and disables the button while busy', async () => {
    const row = makeRow();

    // Pin the refresh promise to a never-resolving value so the
    // "busy" state holds for the duration of the assertions.
    let resolveRefresh: (v: { snapshots: never[] }) => void = () => {
      /* noop */
    };
    const pendingRefresh = new Promise<{ snapshots: never[] }>((resolve) => {
      resolveRefresh = resolve;
    });
    const refreshProviderQuota = vi.fn(async () => pendingRefresh);

    const { listProviderAuths } = installDesktopBridge({
      providerAuthRows: [row],
      refreshProviderQuota,
    });

    render(<SettingsView />);

    // Wait for the initial load to populate the row.
    await waitFor(() => {
      expect(
        screen.getByTestId(`provider-auth-list-row-${row.id}`),
      ).toBeDefined();
    });

    const refreshBtn = screen.getByTestId(
      `provider-auth-list-row-${row.id}-refresh`,
    ) as HTMLButtonElement;
    fireEvent.click(refreshBtn);

    // The IPC fires immediately on click; the button transitions
    // into the disabled "刷新中…" state while the promise is pending.
    await waitFor(() => {
      expect(refreshProviderQuota).toHaveBeenCalledTimes(1);
    });
    expect(refreshProviderQuota).toHaveBeenCalledWith({ id: row.id });

    // Re-fetch the button reference because the React render cycle
    // may have rebuilt the DOM node after state transitions.
    await waitFor(() => {
      const stillBusy = screen.getByTestId(
        `provider-auth-list-row-${row.id}-refresh`,
      ) as HTMLButtonElement;
      expect(stillBusy.disabled).toBe(true);
      expect(stillBusy.getAttribute('data-busy')).toBe('true');
    });

    // Resolve the pending promise so the test does not leak a
    // hanging promise into vitest's exit handlers. The refresh
    // handler will then re-fetch via `listProviderAuths`, hence the
    // ≥2 expectation below.
    resolveRefresh({ snapshots: [] });

    await waitFor(() => {
      expect(listProviderAuths.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

// ===========================================================================
// Delete click — Requirement 12.5 + 12.2: clicking Delete calls
// `desktop.deleteProviderAuth({ id })` and the row is removed from the UI.
// ===========================================================================

describe('SettingsView Provider_Auth — Delete click', () => {
  it('calls desktop.deleteProviderAuth({ id }) and removes the row', async () => {
    const row = makeRow();
    const { deleteProviderAuth } = installDesktopBridge({
      providerAuthRows: [row],
    });

    render(<SettingsView />);

    await waitFor(() => {
      expect(
        screen.getByTestId(`provider-auth-list-row-${row.id}`),
      ).toBeDefined();
    });

    fireEvent.click(
      screen.getByTestId(`provider-auth-list-row-${row.id}-delete`),
    );

    await waitFor(() => {
      expect(deleteProviderAuth).toHaveBeenCalledTimes(1);
    });
    expect(deleteProviderAuth).toHaveBeenCalledWith({ id: row.id });

    // The row disappears from the DOM after the IPC settles.
    await waitFor(() => {
      expect(
        screen.queryByTestId(`provider-auth-list-row-${row.id}`),
      ).toBeNull();
    });

    // With no rows left, the empty-state copy reappears.
    expect(screen.getByTestId('provider-auth-list-empty')).toBeDefined();
  });
});

// ===========================================================================
// `quota_capability='health_only'` — Requirement 12.3 (no percentage,
// shows the explainer copy). End-to-end version of the same case in
// `ProviderAuthList.test.tsx`, exercising the row through the parent
// SettingsView mount flow.
// ===========================================================================

describe('SettingsView Provider_Auth — health_only row integration', () => {
  it('renders the health_only explainer copy and no percentage for a health_only row', async () => {
    const row = makeRow({
      provider: 'deepseek',
      quotaCapability: 'health_only',
      label: 'deepseek-key-1',
    });
    installDesktopBridge({ providerAuthRows: [row] });

    render(<SettingsView />);

    await waitFor(() => {
      expect(
        screen.getByTestId(
          `provider-auth-list-row-${row.id}-capability-hint`,
        ),
      ).toBeDefined();
    });

    const hint = screen.getByTestId(
      `provider-auth-list-row-${row.id}-capability-hint`,
    );
    expect(hint.textContent ?? '').toMatch(/暂无官方\s*quota\s*接口/);

    const rowEl = screen.getByTestId(`provider-auth-list-row-${row.id}`);
    expect(rowEl.textContent ?? '').not.toMatch(/%/);
  });
});

// ===========================================================================
// `last_error_code='auth_expired'` — Requirement 12.5 (Refresh disabled,
// re-import copy shown). End-to-end version exercising the row through
// the parent SettingsView mount flow.
// ===========================================================================

describe('SettingsView Provider_Auth — auth_expired row integration', () => {
  it('disables Refresh and shows the re-import copy for an auth_expired row', async () => {
    const row = makeRow({
      lastErrorCode: 'auth_expired' as ProviderAuthErrorCode,
      lastErrorMessage: 'token expired',
    });
    const { refreshProviderQuota } = installDesktopBridge({
      providerAuthRows: [row],
    });

    render(<SettingsView />);

    await waitFor(() => {
      expect(
        screen.getByTestId(`provider-auth-list-row-${row.id}`),
      ).toBeDefined();
    });

    const refreshBtn = screen.getByTestId(
      `provider-auth-list-row-${row.id}-refresh`,
    ) as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);

    const expiredHint = screen.getByTestId(
      `provider-auth-list-row-${row.id}-expired-hint`,
    );
    expect(expiredHint.textContent ?? '').toMatch(
      /认证已过期.*CPA.*重新导出.*导入/,
    );

    // The disabled button must not fire the IPC even on a click
    // attempt — jsdom mirrors the browser's "disabled" semantics.
    fireEvent.click(refreshBtn);
    expect(refreshProviderQuota).not.toHaveBeenCalled();
  });
});
