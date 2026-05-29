// Main-process boot sequence. Wires the SQLite store, secrets,
// scheduler, retention job, and the compact window together; later
// phases hook in collectors (5.x), services (3.x / 7.x), and the IPC
// handler registry (3.11) at the marked TODO sites.
//
// References:
//   - design.md §Compact Window Boot — First Render
//   - design.md §Default intervals
//   - design.md §Architecture (`app.ts (entry, wiring)`)
//   - PLAN.md §Main Process Implementation — `app.ts`

import { app, BrowserWindow, dialog, Menu, safeStorage, session, Tray } from 'electron';

import { setAutostart } from './autostart';
import { registerIpcHandlers, type InflightConfigSwitchRegistry, type IpcRegistry } from './ipc';
import {
  initSecrets,
  type SecretsStore,
} from './security/secrets';
import {
  createDashboardService,
  type DashboardService,
} from './services/dashboard.service';
import {
  createHealthService,
} from './services/health.service';
import {
  AuthError,
  createOpenClashClient,
  type OpenClashClient,
} from './services/openclash.service';
import {
  createConfigSwitchAuditService,
  type ConfigSwitchAuditService,
} from './services/openclash.config.audit';
import {
  createOpenClashManagementClient,
  type OpenClashManagementClient,
} from './services/openclash.management.service';
import {
  createSwitchNodeService,
  type SwitchNodeService,
} from './services/openclash.switch';
import {
  createSwitchLock,
  type SwitchLock,
  type SwitchLockToken,
} from './services/switch.lock';
import {
  createUsageService,
  type UsageService,
} from './services/usage.service';
import {
  createDiagnosticsService,
  type DiagnosticsService,
} from './services/diagnostics.service';
import {
  createNetworkCollectorTask,
} from './collectors/network.collector';
import {
  createOpenClashCollectorTask,
} from './collectors/openclash.collector';
import {
  createNodeScanCollectorTask,
} from './collectors/nodeScan.collector';
import {
  initScheduler,
  type CollectorHealthRecorder,
  type Scheduler,
} from './scheduler';
import { openDatabase, type MonitorDatabase } from './store/db';
import { runMigrations } from './store/migrations';
import {
  createRepositories,
  readAppSettings,
  writeAppSettings,
  type Repositories,
  type SecretsRepository,
} from './store/repositories';
import {
  createRetentionTask,
  RETENTION_TASK_ID,
} from './store/retention';
import { COMPACT_DEFAULT_SIZE, createCompactWindow, createExpandedWindow } from './windows';
import { createTray } from './tray';
// `app.ts` no longer drives per-collector usage ticks (the AI
// Accounts unification moved that responsibility to
// `quotaService.refresh` against `provider_auth` rows); the legacy
// usage collector factories below are intentionally NOT imported
// here. The factory modules continue to live in
// `./collectors/usage/*` for the Codex local-log fallback inside
// `quotaService` and for any future per-account adapter code.
import type { AppSettings, AppearanceSettings } from './types';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Default settings seed
// ---------------------------------------------------------------------------

/**
 * The seed value persisted under `app.settings` on first launch.
 *
 * Mirrors design.md §Validation rules (controllerUrl format, probe
 * URL list, switch-verify delay) and design.md §Default intervals
 * (per-task tick rates).
 *
 * Exported (test-only) so `cpa-quota-import` Property 5
 * (`schemas.app-defaults.pbt.test.ts`) can assert that the seeded
 * blob round-trips through `appSettingsSchema` without instantiating
 * the full Electron boot sequence. Production callers reach the seed
 * via {@link loadOrSeedAppSettings}.
 */
export function buildDefaultAppSettings(): AppSettings {
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
    autostart: false,
    configSwitchVerifyWindowMs: 8_000,
    managementInterface: {
      kind: 'openclash-luci',
      url: '',
      requestTimeoutMs: 10_000,
      configFileWhitelist: [],
    },
    cliproxy: {
      enabled: false,
      managementUrl: '',
      authDir: '',
      usageQueueBatchSize: 25,
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

/**
 * Fill in any forward-compat fields missing from a previously
 * persisted `AppSettings` row. Older databases may be missing newer
 * blocks (`appearance` from the theme system, `cliproxy` from the
 * CLIProxyAPI usage importer); the strict zod schema would reject
 * them on load. We patch them here once at boot, and write the
 * patched value back through {@link writeAppSettings} so the next
 * launch hits the fast path with no normalize work to do.
 *
 * The function is intentionally pure — callers compare its output
 * with the original to decide whether a write-back is needed.
 */
function normalizeAppSettings(raw: AppSettings): AppSettings {
  // Pre-theme-system rows are missing `appearance`. Pre-network-quick-actions
  // rows are missing `managementInterface` and `configSwitchVerifyWindowMs`.
  // Pre-cpa-quota-import rows are missing `cliproxy`. Patch each block
  // independently so an in-place upgrade across multiple feature
  // generations still produces a valid `AppSettings`.
  //
  // Theme system v2 added six new design-language presets but kept
  // every v1 preset (obsidian-glass / aurora-ring / holo-grid /
  // liquid-metal / signal-pulse) as additional options. We keep a
  // defensive fallback in case the persisted value is some other
  // unknown literal (e.g. a value from a never-shipped intermediate
  // build): unknown values fall through to `mint-monitor`, the new
  // default reference design.
  const VALID_COMPACT_THEMES = new Set<string>([
    'liquid-glass',
    'material-you',
    'soft-neumorph',
    'paper-dashboard',
    'mint-monitor',
    'device-oled',
    'obsidian-glass',
    'aurora-ring',
    'holo-grid',
    'liquid-metal',
    'signal-pulse',
  ]);
  const rawTheme = raw.appearance?.compactTheme as string | undefined;
  const compactTheme: AppearanceSettings['compactTheme'] =
    rawTheme !== undefined && VALID_COMPACT_THEMES.has(rawTheme)
      ? (rawTheme as AppearanceSettings['compactTheme'])
      : ('mint-monitor' as const);
  const rawZoom = raw.appearance?.compactZoom;
  const compactZoom =
    typeof rawZoom === 'number' && Number.isFinite(rawZoom)
      ? Math.min(2, Math.max(1, rawZoom))
      : 1;
  const appearance = {
    colorMode: raw.appearance?.colorMode ?? ('dark' as const),
    compactTheme,
    fontScale: raw.appearance?.fontScale ?? 1,
    compactZoom,
  };
  const cliproxy = raw.cliproxy ?? {
    enabled: false,
    managementUrl: '',
    authDir: '',
    usageQueueBatchSize: 25,
  };
  const managementInterface = raw.managementInterface ?? {
    kind: 'openclash-luci' as const,
    url: '',
    requestTimeoutMs: 10_000,
    configFileWhitelist: [],
  };
  const configSwitchVerifyWindowMs =
    raw.configSwitchVerifyWindowMs ?? 8_000;
  const kiroTokenRefresh = raw.kiroTokenRefresh ?? {
    enabled: true,
    writeBackAuthFile: true,
  };
  return {
    ...raw,
    managementInterface,
    configSwitchVerifyWindowMs,
    cliproxy,
    appearance,
    kiroTokenRefresh,
  };
}

function upgradeProviderAuthCapabilities(repositories: Repositories): void {
  const now = Date.now();
  for (const row of repositories.providerAuth.list()) {
    if (row.provider === 'deepseek' && row.quotaCapability !== 'official') {
      repositories.providerAuth.update(row.id, {
        quotaCapability: 'official',
        updatedAt: now,
      });
    }
  }
}

/**
 * Read the persisted `AppSettings` blob, seeding the default value on
 * the first launch (when no row exists yet).
 *
 * Returns the live settings used by the rest of the boot sequence —
 * window factory, scheduler intervals (task 3.x), CSP allowlist.
 */
function loadOrSeedAppSettings(repos: Repositories): AppSettings {
  const existing = readAppSettings(repos.settings);
  if (existing !== undefined) {
    // Forward-compat: older rows may be missing `appearance` (added
    // by the theme-system feature). The strict zod schema would
    // reject such rows on read, so we patch them in place and
    // persist the patched value once. JSON-string equality is fine
    // here — the settings tree is small and the comparison happens
    // at most once per boot.
    const normalized = normalizeAppSettings(existing);
    if (JSON.stringify(normalized) !== JSON.stringify(existing)) {
      writeAppSettings(repos.settings, normalized);
    }
    return normalized;
  }
  const seeded = buildDefaultAppSettings();
  writeAppSettings(repos.settings, seeded);
  return seeded;
}

// ---------------------------------------------------------------------------
// Adapters between the modules' interfaces
// ---------------------------------------------------------------------------

/**
 * Bridge a {@link SecretsRepository} (Buffer | undefined) to the
 * {@link SecretsStore} contract (Buffer | null) the secrets module
 * expects. Keeps the secrets module decoupled from the SQLite layer.
 */
function adaptSecretsRepository(repo: SecretsRepository): SecretsStore {
  return {
    getEncrypted(key) {
      const value = repo.get(key);
      return value ?? null;
    },
    setEncrypted(key, value) {
      repo.set(key, value);
    },
    deleteByKey(key) {
      repo.remove(key);
    },
  };
}

/**
 * Bridge the scheduler's {@link CollectorHealthRecorder} contract to
 * the `collector_health` repository. The repository does not (yet)
 * have a `recordRunStart` operation — it is recorded implicitly via
 * `last_run_at` on `recordSuccess` / `recordFailure`. We pass a no-op
 * here so the scheduler's per-tick instrumentation continues to work.
 */
function buildHealthRecorder(repos: Repositories): CollectorHealthRecorder {
  return {
    recordRunStart(_collectorId, _at) {
      // No-op: `collector_health` only models the last run / last
      // success / last failure. The scheduler still asks us to record
      // a start so future instrumentation has a hook (task 5.x).
    },
    recordRunSuccess(collectorId, at) {
      repos.collectorHealth.recordSuccess(collectorId, at);
    },
    recordRunFailure(collectorId, at, error) {
      repos.collectorHealth.recordFailure(collectorId, at, error);
    },
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Process-wide handles populated by {@link boot}. Exposed for future
 * tasks (tray lifecycle 9.6, settings reload 9.1) that need to reach
 * the live DB / scheduler without re-importing them through every
 * call chain.
 *
 * Kept private to the module (no `export`) because the canonical
 * accessor for the scheduler is `getScheduler()` from
 * `./scheduler.ts`; the DB and repositories will get their own
 * accessors when later phases need them.
 */
let _db: MonitorDatabase | null = null;
let _repositories: Repositories | null = null;
let _scheduler: Scheduler | null = null;
let _settings: AppSettings | null = null;
let _compactWindow: BrowserWindow | null = null;
let _expandedWindow: BrowserWindow | null = null;
let _tray: Tray | null = null;
let _openClashClient: OpenClashClient | null = null;
let _openClashManagementClient: OpenClashManagementClient | null = null;
let _dashboardService: DashboardService | null = null;
let _switchNodeService: SwitchNodeService | null = null;
let _switchLock: SwitchLock | null = null;
let _configSwitchAudit: ConfigSwitchAuditService | null = null;
let _inflightConfigSwitches: InflightConfigSwitchRegistry | null = null;
let _ipcRegistry: IpcRegistry | null = null;

/**
 * Module-level flag flipped synchronously by the `before-quit`
 * listener registered at the head of {@link boot}. Per Requirement
 * 8.5, the flag must be observable from any subsequent `before-quit`
 * listener registered after the application's, so we hoist it from
 * the previous {@link tray.ts} closure to module scope and read it
 * through {@link isAppQuitting} from collaborators (e.g. the tray's
 * compact-window-close hide guard).
 *
 * Read-only outside this module; the value transitions exactly once,
 * from `false` to `true`, when `before-quit` fires for the first
 * time. Subsequent `before-quit` events (re-entrant or not) leave it
 * at `true`.
 */
let _isQuitting = false;

/**
 * Exposed for {@link tray.ts}'s compact-window close-event hide guard
 * and for unit tests asserting Requirement 8.5. Returns the live
 * value of the module-level {@link _isQuitting} flag rather than a
 * snapshot, so a caller stashed at boot can see post-flip transitions
 * without re-resolving the import.
 */
export function isAppQuitting(): boolean {
  return _isQuitting;
}

/**
 * Register the `before-quit` listener that synchronously flips the
 * module-level {@link _isQuitting} flag (Requirement 8.5). Extracted
 * from the body of {@link boot} so the lifecycle unit test can drive
 * it directly without standing up the full SQLite / scheduler / IPC
 * stack.
 *
 * The listener is registered exactly once per `boot()` invocation;
 * the test harness re-imports the module per case (`vi.resetModules`)
 * so each case gets a fresh registration on a fresh mocked `app`.
 *
 * Exported only for test access; production callers reach this code
 * path implicitly via {@link main} → {@link boot}.
 */
export function __registerBeforeQuitFlagFlipper(): void {
  app.on('before-quit', () => {
    _isQuitting = true;
  });
}

/**
 * Test-only reset of the module-level {@link _isQuitting} flag.
 * Production code never resets the flag (the value is monotonic
 * once `before-quit` fires). The lifecycle unit test resets it
 * between cases that share the same module instance to keep the
 * cases independent.
 */
export function __resetIsQuittingForTests(): void {
  _isQuitting = false;
}

const COMPACT_AUTO_MIN_HEIGHT = 40;
const COMPACT_AUTO_MAX_HEIGHT = 720;
const COMPACT_AUTO_MIN_WIDTH = 56;
const COMPACT_AUTO_MAX_WIDTH = 360;

/**
 * Maximum supported compact-window zoom factor. Mirrors the
 * `appearance.compactZoom` schema upper bound. Used to clamp the
 * BrowserWindow's `maxWidth/maxHeight` so a zoomed widget can grow
 * to its true device-pixel footprint.
 */
const COMPACT_MAX_ZOOM = 2;

/**
 * Last CSS-pixel size reported by the renderer's auto-measure hook
 * (`desktop:resizeCompactWindow`). The renderer measures content in
 * CSS pixels (independent of `webContents.setZoomFactor`); we
 * multiply by the live `appearance.compactZoom` to derive the
 * physical DIP size. Cached so a zoom change can re-apply the size
 * without waiting for the next renderer tick.
 */
let _lastCompactCssSize: { width: number; height: number } | null = null;

async function boot(): Promise<void> {
  // 0. Register the `before-quit` listener FIRST so the module-level
  //    `_isQuitting` flag flips synchronously before any subsequent
  //    listener observes the event (Requirement 8.5). The flag is
  //    read by {@link tray.ts}'s compact-window close guard via
  //    {@link isAppQuitting} so a tray "退出" click hides nothing —
  //    it lets the close cascade through to a real quit.
  //
  //    Registering the listener at the very top of `boot()` makes it
  //    the first `before-quit` listener in the application's chain;
  //    Electron invokes listeners in registration order, so any
  //    second listener (an in-process unit test, a future shutdown
  //    hook) attached later observes `_isQuitting === true`
  //    synchronously by the time its callback runs.
  __registerBeforeQuitFlagFlipper();

  // 1. Open the application database and apply migrations.
  const db = openDatabase();
  runMigrations(db);
  _db = db;

  // 2. Build the typed repositories bundle (settings, secrets,
  //    samples, usage events, collector_health).
  const repositories = createRepositories(db);
  _repositories = repositories;
  upgradeProviderAuthCapabilities(repositories);

  // 3. Initialise the secrets singleton against Electron `safeStorage`
  //    and the SQLite-backed secrets repository (design.md §Property
  //    10). All subsequent calls go through the module-level `secrets`
  //    accessor exported from `./security/secrets.ts`.
  initSecrets({
    store: adaptSecretsRepository(repositories.secrets),
    safeStorage,
  });

  // OpenClash controller secret is written exclusively through the
  // Settings UI via the dedicated `updateSecret` IPC channel. No
  // hardcoded seed value ships in source.

  // 4. Load (or seed) the canonical `AppSettings` blob so the window
  //    factory and the scheduler can read live values.
  const settings = loadOrSeedAppSettings(repositories);
  _settings = settings;

  // 5. Build the scheduler. Concrete collectors are NOT registered
  //    here yet — tasks 5.4 / 5.5 / 5.6 (network, openclash, usage)
  //    and 7.2 (current-node + nodeScan) hook in via `getScheduler()`.
  const scheduler = initScheduler({
    recorder: buildHealthRecorder(repositories),
  });
  _scheduler = scheduler;

  // TODO(task 5.6): scheduler.register(usageCollectorTask(...))
  // TODO(task 7.2): scheduler.register(currentNodeProbeTask(...))

  // 6. Retention is the only task we wire in this phase. Register it
  //    and run it once at boot per design.md §Retention Cleanup.
  scheduler.register(
    createRetentionTask(db, {
      intervalMs: settings.refreshIntervals.retentionMs,
    }),
  );
  scheduler.start();
  await scheduler.runNow(RETENTION_TASK_ID);

  // 7. Create the always-on-top compact window. The factory installs
  //    CSP headers and navigation guards before the renderer loads.
  const compactWindow = createCompactWindow({
    controllerUrl: settings.controllerUrl,
    managementUrl: settings.managementInterface.url,
    settings: repositories.settings,
    session: session.defaultSession,
  });
  _compactWindow = compactWindow;

  // Apply the persisted compact zoom as soon as the renderer is
  // ready. `setZoomFactor` only takes effect on a live webContents;
  // calling it before `did-finish-load` is a no-op, so we guard with
  // the same event the renderer uses for first paint. The settings
  // patch path (`applyAppSettingsPatch`) re-applies on every change.
  compactWindow.webContents.once('did-finish-load', () => {
    applyCompactZoom();
  });

  // 8. Construct the OpenClash HTTP client and its derived services.
  //    `controllerUrl` is read live so user edits in Settings (task
  //    9.1) take effect on the very next request without rebuilding
  //    the client. Secrets are sourced through the singleton
  //    initialised in step 3.
  const openClashClient = createOpenClashClient({
    controllerUrl: () => (_settings ?? settings).controllerUrl,
  });
  _openClashClient = openClashClient;

  // OpenClash LuCI management client (network-quick-actions task 8.x +
  // 10.5). Reads creds lazily via the `secrets` singleton, writes
  // health metrics to the `openclash.management` row of
  // `collector_health`, and uses the controller HTTP client as its
  // verify-loop liveness probe. Constructed once here so the IPC
  // registry's `clearManagementCredentials` handler can call
  // `invalidateSession()` on the same instance the (future)
  // `switchOpenClashConfig` handler will drive.
  const { secrets: secretsModule } =
    require('./security/secrets') as typeof import('./security/secrets');
  const openClashManagementClient = createOpenClashManagementClient({
    secrets: secretsModule,
    collectorHealthRepo: repositories.collectorHealth,
    // Liveness probe used by the management client's verify loop:
    // a 2xx (kernel up) OR a 401 (kernel up but auth required) both
    // count as "controller is alive". Any other thrown class — network
    // error, parse error, non-401 HTTP error — counts as "down".
    controllerHealthcheck: async (opts) => {
      try {
        await openClashClient.getConfigs({ timeoutMs: opts.timeoutMs });
        return true;
      } catch (err) {
        if (err instanceof AuthError) return true;
        return false;
      }
    },
    getAppSettings: () => _settings ?? settings,
  });
  _openClashManagementClient = openClashManagementClient;

  // OpenClash config-switch audit writer (network-quick-actions
  // task 6.1 / 10.4). Wraps the `OpenClashConfigChangesRepository`
  // with the orchestrator-shaped `recordSwitchStart` /
  // `recordSwitchEnd` helpers and pins the `confirmed: true`
  // invariant (Requirement 6) at the call boundary.
  const configSwitchAudit = createConfigSwitchAuditService({
    repository: repositories.openClashConfigChanges,
  });
  _configSwitchAudit = configSwitchAudit;

  // In-flight `'config'` switch registry. Lives at this scope —
  // outside the IPC handler — so the lock's `onForceRelease`
  // watchdog callback (constructed below) can read entries that
  // belong to switches the orchestrator never had a chance to clean
  // up. The IPC handler clears entries at the head of its `finally`
  // block so a normal-path completion always wins the race against
  // a watchdog firing a tick later. Token-id keyed because the lock
  // tokens themselves are immutable and the id survives JSON
  // round-trips.
  const inflightConfigSwitches: InflightConfigSwitchRegistry = new Map();
  _inflightConfigSwitches = inflightConfigSwitches;

  // Globally-exclusive switch mutex. The `onForceRelease` callback
  // is the watchdog's only side-effect: when the lock fires after
  // `2 × configSwitchVerifyWindowMs` without a release call, we
  // synthesise a `verify_timeout` end audit row on the orchestrator's
  // behalf so the table never carries an unbalanced `'start'` row
  // (Requirement 9.5 + Property 6).
  //
  // Key safety properties:
  //   - We `delete` the in-flight entry BEFORE writing the end row
  //     so a concurrent normal-path completion that races into the
  //     orchestrator's `finally` cannot also write a duplicate end
  //     row (whichever side reads-and-deletes first wins).
  //   - The audit writer swallows internal errors, so this callback
  //     is total; any thrown error is also caught by the lock's
  //     own watchdog wrapper (see switch.lock.ts comments).
  //   - We never call `switchLock.release` from inside the
  //     callback — the lock has already removed the token by the
  //     time `onForceRelease` is invoked.
  const switchLock = createSwitchLock({
    onForceRelease: (token: SwitchLockToken) => {
      if (token.kind.type !== 'config') {
        // Only `'config'` switches own audit rows. Node switches
        // have their own watchdog story on the `switchNode` path.
        return;
      }
      const meta = inflightConfigSwitches.get(token.id);
      if (meta === undefined) {
        // Either the orchestrator's `finally` already won the race
        // and dropped the entry, or this token was never tracked
        // (defensive — every `'config'` lock acquire by the IPC
        // handler stashes its metadata before `await`-ing the
        // management client). Nothing to do.
        return;
      }
      inflightConfigSwitches.delete(token.id);
      const endTs = Date.now();
      configSwitchAudit.recordSwitchEnd({
        rowId: meta.auditRowId,
        targetPath: meta.targetPath,
        startPath: meta.startPath,
        finalPath: null,
        resultCode: 'verify_timeout',
        startedAt: meta.startTs,
        endedAt: endTs,
      });
    },
  });
  _switchLock = switchLock;

  const dashboardService = createDashboardService({
    repositories,
    getControllerUrl: () => (_settings ?? settings).controllerUrl,
    getProbeUrls: () => (_settings ?? settings).probeUrls,
    // Health evaluator with verify-window flap suppression
    // (network-quick-actions Requirement 5.10, design.md §Property 8).
    //
    // The `switchLock` instance constructed above is the live source
    // of truth for "is a `'config'` switch in flight?"; the health
    // service's wrapper reads `snapshot()` on every evaluation and
    // suppresses `openclash_unreachable` escalation while the lock
    // is held + the down-streak is shorter than the verify window
    // (network-quick-actions task 12.1).
    evaluateHealth: createHealthService({
      getConfigSwitchVerifyWindowMs: () =>
        (_settings ?? settings).configSwitchVerifyWindowMs,
      switchLock,
    }).evaluate,
  });
  _dashboardService = dashboardService;

  const switchNodeService = createSwitchNodeService({
    client: openClashClient,
    snapshotsRepo: repositories.openClashSnapshots,
    getSwitchVerifyDelayMs: () =>
      (_settings ?? settings).switchVerifyDelayMs,
  });
  _switchNodeService = switchNodeService;

  // Usage service (task 7.8)
  const usageService = createUsageService({
    usageEvents: repositories.usageEvents,
    settings: repositories.settings,
    providerAuth: repositories.providerAuth,
    quotaSnapshots: () => repositories.settings.get<any[]>('quota.snapshots') ?? [],
  });

  // Quota service (cpa-quota-import task 6.2). The aggregator now
  // dispatches per `provider_auth` row through the placeholder
  // adapter registry; the legacy Codex local-log path is retained as
  // a fallback when no Codex `provider_auth` row exists
  // (Requirement 11.6). Full wiring of the new IPC channels (list /
  // import / delete / refreshProviderQuota / validate) lands in task
  // 10.x; this constructor only hooks the dependencies the existing
  // `getQuotaStatus` IPC needs.
  const { createQuotaService } = require('./services/quota.service') as typeof import('./services/quota.service');
  const { createSecretsAdmin } = require('./security/secrets.admin') as typeof import('./security/secrets.admin');
  const { buildAdapterRegistry } = require('./services/quota/adapters') as typeof import('./services/quota/adapters');
  // Codex local-log fallback (`parseLocalRateLimits`) is intentionally
  // NOT wired in. The AI Accounts unification makes the per-account
  // `provider_auth` row the single source of truth for which providers
  // appear in the quota / usage UI; the legacy fallback would cause a
  // Codex card to surface in the floating widget whenever
  // `~/.codex/sessions/...` exists on disk, even when the user has no
  // imported account. Removing the dep collapses the fallback branch
  // inside `quotaService.refresh`.
  const secretsAdmin = createSecretsAdmin(secretsModule);
  // The Kiro IDE adapter consults `kiroTokenRefresh` settings on
  // every refresh, so pass it a thunk pointing at the live
  // memoised `_settings` rather than a snapshot — a Settings UI
  // toggle then takes effect on the next quota tick without restart.
  const adapterRegistry = buildAdapterRegistry({
    getSettings: () => _settings ?? settings,
  });
  const quotaService = createQuotaService({
    settings: repositories.settings,
    providerAuth: repositories.providerAuth,
    secrets: secretsAdmin,
    adapters: adapterRegistry,
  });

  // Provider_Auth service (cpa-quota-import task 10.5). Owns import /
  // list / delete / validate against the `provider_auth` repository
  // and the `cpaAuth.providerAuth.<uuid>` secret namespace via the
  // `secretsAdmin` wrapper. The dialog runs in main — the renderer's
  // `importProviderAuthFile` IPC only carries `{ provider }`; the
  // returned file path never crosses the IPC boundary
  // (design.md §Layered Trust Model + Requirement 8.1 / 8.2).
  //
  // Dialog options match design.md §Provider_Auth_Service:
  //   properties: ['openFile']
  //   filters:
  //     - { name: 'CPA Auth', extensions: ['json', 'txt'] }
  //     - { name: 'All',      extensions: ['*']         }
  //
  // The owning window is the compact window (the always-on-top boot
  // window); on macOS this anchors the dialog to that window so the
  // user cannot lose it behind another app, and on Windows/Linux it
  // is harmless. `dialog.showOpenDialog(BrowserWindow, ...)` accepts
  // a possibly-destroyed window handle gracefully.
  const { createProviderAuthService } =
    require('./services/provider_auth.service') as typeof import('./services/provider_auth.service');
  const { parseAuthFile } =
    require('./services/auth-file.parser') as typeof import('./services/auth-file.parser');
  const providerAuthService = createProviderAuthService({
    repo: repositories.providerAuth,
    secrets: secretsAdmin,
    showOpenDialog: () =>
      dialog.showOpenDialog(compactWindow, {
        properties: ['openFile'],
        filters: [
          { name: 'CPA Auth', extensions: ['json', 'txt'] },
          { name: 'All', extensions: ['*'] },
        ],
      }),
    readFile: (p) => fs.promises.readFile(p, 'utf-8'),
    statFile: (p) => fs.promises.stat(p).then((s) => ({ size: s.size })),
    parse: parseAuthFile,
    uuid: () => crypto.randomUUID(),
    now: () => Date.now(),
  });

  // Auto-discovery: scan the user's well-known credential paths
  // (`~/.codex/auth.json`, `~/.claude/.credentials.json`,
  // `~/.gemini/oauth_creds.json`, `~/.antigravity/auth.json`) and
  // import any unknown credential as a fresh `provider_auth` row
  // with `enabled: true` so it participates in the next quota
  // refresh tick. The scan is idempotent — credentials that
  // already exist on disk and have already been imported (manually
  // or by a previous boot) are detected via secret-fingerprint
  // matching and skipped.
  //
  // Errors are non-fatal: a missing or unreadable file MUST NOT
  // prevent the rest of the boot sequence from completing. The
  // service swallows individual probe failures internally.
  const { runDiscovery: runAuthFileDiscovery } =
    require('./services/auth-file.discovery') as typeof import('./services/auth-file.discovery');
  void runAuthFileDiscovery({
    providerAuthRepo: repositories.providerAuth,
    secrets: secretsAdmin,
  })
    .then((report) => {
      if (report.imported > 0) {
        // eslint-disable-next-line no-console
        console.info(
          `[auth-discovery] imported=${report.imported} skipped=${report.skipped} failed=${report.failed} missing=${report.missing}`,
        );
      }
    })
    .catch(() => {
      // Discovery never throws but defence-in-depth: if it did,
      // we do not want it to crash the boot.
    });

  // Diagnostics service (task 9.3 + network-quick-actions task 11.1).
  // The `openClashConfigChanges` repository feeds the
  // `recentConfigSwitches` field added by Requirement 8.4; the
  // management interface summary (Requirement 12.4) is read live from
  // the `AppSettings` blob via the same `settings` repo.
  const diagnosticsService = createDiagnosticsService({
    settings: repositories.settings,
    collectorHealth: repositories.collectorHealth,
    openClashConfigChanges: repositories.openClashConfigChanges,
    providerAuth: repositories.providerAuth,
    getSecretValues: () => {
      try {
        const { secrets: sec } = require('./security/secrets') as typeof import('./security/secrets');
        // Collect all known secret keys
        const keys = [
          'openclash.controllerSecret',
          'openclash.management.username',
          'openclash.management.password',
          'deepseek_api_key',
        ];
        return keys.map((k) => sec.get(k)).filter((v): v is string => v !== null);
      } catch {
        return [];
      }
    },
  });

  // Subscribe the compact window to the dashboard push channel so
  // collectors that land in tasks 5.x can broadcast updates without
  // every reaching for the BrowserWindow directly. The webContents
  // unsubscribes itself via `destroyed` (handled inside the service).
  dashboardService.attachPushChannel(compactWindow.webContents);

  // Hydrate the sparkline ring buffer from DB on cold boot so the
  // renderer has latency history available on first render.
  dashboardService.hydrateSparklineFromDb();

  // --- Register collectors (tasks 5.4 / 5.5 / 5.7) ---
  // Each collector's `onAfterTick` triggers a dashboard rebroadcast
  // so every probe write pushes a fresh DashboardState to renderers.
  const onAfterTick = (): void => {
    dashboardService.broadcastDashboard();
  };

  scheduler.register(
    createNetworkCollectorTask({
      repositories: { networkSamples: repositories.networkSamples },
      getRouterHealth: () => (_settings ?? settings).routerHealth,
      getControllerUrl: () => (_settings ?? settings).controllerUrl,
      getIntervalMs: () => (_settings ?? settings).refreshIntervals.networkMs,
      onAfterTick,
    }),
  );

  let consecutiveProbeFailures = 0;

  scheduler.register(
    createOpenClashCollectorTask({
      repositories: {
        networkSamples: repositories.networkSamples,
        openclashSnapshots: repositories.openClashSnapshots,
      },
      client: openClashClient,
      getSettings: () => _settings ?? settings,
      getIntervalMs: () => (_settings ?? settings).refreshIntervals.openclashMs,
      onProbeResults: (results) => {
        dashboardService.setCurrentProbeResults(results);
        if (results.length === 0) {
          return;
        }
        for (const result of results) {
          if (result.ok && result.latencyMs !== null) {
            dashboardService.pushLatencySample(result.latencyMs);
          }
        }
        consecutiveProbeFailures = results.every((result) => !result.ok)
          ? consecutiveProbeFailures + 1
          : 0;
        dashboardService.setConsecutiveProbeFailures(
          consecutiveProbeFailures,
        );
      },
      onAfterTick,
    }),
  );

  scheduler.register(
    createNodeScanCollectorTask({
      repositories: {
        nodeSamples: repositories.nodeSamples,
        settings: repositories.settings,
      },
      client: openClashClient,
      getSettings: () => _settings ?? settings,
      getIntervalMs: () => (_settings ?? settings).refreshIntervals.nodeScanMs,
      onAfterTick,
    }),
  );

  // 9. Register IPC handlers. Every channel runs the matching zod
  //    schema before touching a service (design.md §Property 12).
  //    `getUsageSummary` and `getDiagnostics` are intentionally NOT
  //    wired yet — tasks 7.8 and 9.3 will inject them — so the
  //    handler returns `{ ok: false, code: 'not_implemented' }` for
  //    those methods until then.
  _ipcRegistry = registerIpcHandlers({
    repositories,
    dashboardService,
    openClashClient,
    switchNodeService,
    openClashManagementClient,
    switchLock,
    configSwitchAudit,
    inflightConfigSwitches,
    getSettings: () => _settings ?? settings,
    updateSettings: (patch) => applyAppSettingsPatch(repositories, patch),
    updateSecret: (input) => {
      const { secrets: sec } = require('./security/secrets') as typeof import('./security/secrets');
      // Allowlist of secret keys the renderer is permitted to write.
      // `openclash.management.{username,password}` are the LuCI
      // session credentials used by the OpenClash management client
      // (network-quick-actions, Requirements 12.1, 12.2). They flow
      // through the same `safeStorage`-backed `secrets` module as
      // `openclash.controllerSecret`.
      const ALLOWED_KEYS = [
        'openclash.controllerSecret',
        'openclash.management.username',
        'openclash.management.password',
      ];
      if (!ALLOWED_KEYS.includes(input.key)) {
        throw new Error(`updateSecret: unknown key '${input.key}'`);
      }
      sec.set(input.key, input.value);
    },
    removeSecret: (key) => {
      const { secrets: sec } = require('./security/secrets') as typeof import('./security/secrets');
      // Mirror of the `updateSecret` allowlist, but narrower: the
      // `clearManagementCredentials` IPC (task 10.5) is the only
      // caller and it only ever wipes the two LuCI keys. The
      // controller secret is rotated via `updateSecret`, never
      // deleted, because clearing it would silently disable the
      // entire dashboard until the user re-enters it.
      const REMOVABLE_KEYS = [
        'openclash.management.username',
        'openclash.management.password',
      ];
      if (!REMOVABLE_KEYS.includes(key)) {
        throw new Error(`removeSecret: refusing to delete '${key}'`);
      }
      sec.remove(key);
    },
    getSecret: (key) => {
      const { secrets: sec } = require('./security/secrets') as typeof import('./security/secrets');
      // Allowlist mirrors `updateSecret` / `removeSecret` — the
      // `getNetworkQuickActions` handler (task 10.3) reads this
      // strictly to answer "is the management interface configured?"
      // (URL non-empty AND both LuCI creds present). Plaintext
      // values never cross the IPC boundary; only the boolean
      // `management.configured` is surfaced.
      const READABLE_KEYS = [
        'openclash.controllerSecret',
        'openclash.management.username',
        'openclash.management.password',
      ];
      if (!READABLE_KEYS.includes(key)) {
        throw new Error(`getSecret: refusing to read '${key}'`);
      }
      try {
        return sec.get(key);
      } catch {
        // `SecretsDecryptError` / `SecretsUnavailableError` collapse
        // to "no secret configured" so the IPC handler treats the
        // management interface as unconfigured rather than crashing
        // the panel render.
        return null;
      }
    },
    getUsageSummary: (range) => usageService.getUsageSummary({ range }),
    getQuotaStatus: () => quotaService.getQuotaStatus(),
    resizeCompactWindow: (input) => applyCompactWindowSize(input),
    providerAuthService,
    quotaService,
    // Broadcaster fans `provider-auth.updated` push events out to
    // every live BrowserWindow (compact + expanded) after each
    // mutation IPC succeeds. Constructed inline so it always sees
    // the current set of windows via `BrowserWindow.getAllWindows()`
    // (we cannot capture a snapshot of the windows because the
    // expanded window is created lazily).
    providerAuthBroadcaster: (() => {
      const {
        createProviderAuthBroadcaster,
      } = require('./services/provider_auth.broadcast') as typeof import(
        './services/provider_auth.broadcast'
      );
      const { BrowserWindow: BW } = require('electron') as typeof import(
        'electron'
      );
      return createProviderAuthBroadcaster({
        getWindows: () => BW.getAllWindows(),
      });
    })(),
    getDiagnostics: () => diagnosticsService.export(),
    runRefreshNow: async () => {
      // Run network / openclash / nodeScan / usage collectors immediately,
      // and trigger a quota refresh against every enabled
      // provider_auth row.
      await Promise.allSettled([
        scheduler.runNow('network'),
        scheduler.runNow('openclash'),
        scheduler.runNow('nodeScan'),
        scheduler.runNow('usage'),
        quotaService.refresh(),
      ]);
    },
    openExpanded: () => openOrFocusExpanded(repositories, settings),
  });

  // 10. Usage collector scheduler (LEGACY collectors path).
  const { createUsageCollectorTask } = require('./collectors/usage/usage.task') as typeof import('./collectors/usage/usage.task');
  const { createCodexCollector } = require('./collectors/usage/codex.collector') as typeof import('./collectors/usage/codex.collector');
  const { createGeminiCollector } = require('./collectors/usage/gemini.collector') as typeof import('./collectors/usage/gemini.collector');
  const { createAntigravityCollector } = require('./collectors/usage/antigravity.collector') as typeof import('./collectors/usage/antigravity.collector');
  const { createOpenCodeCollector } = require('./collectors/usage/opencode.collector') as typeof import('./collectors/usage/opencode.collector');
  const { createClaudeCodeCollector } = require('./collectors/usage/claudeCode.collector') as typeof import('./collectors/usage/claudeCode.collector');
  const { createKiroCollector } = require('./collectors/usage/kiro.collector') as typeof import('./collectors/usage/kiro.collector');

  scheduler.register(
    createUsageCollectorTask({
      collectors: [
        createCodexCollector(),
        createGeminiCollector(),
        createAntigravityCollector(),
        createOpenCodeCollector(),
        createClaudeCodeCollector(),
        createKiroCollector(),
      ],
      repositories: {
        usageEvents: repositories.usageEvents,
        settings: repositories.settings,
        collectorHealth: repositories.collectorHealth,
      },
      getIntervalMs: () => (_settings ?? settings).refreshIntervals.usageMs,
      onAfterTick: () => {
        dashboardService.broadcastDashboard();
      },
    })
  );

  // 11. System tray. Holds the app lifecycle on Windows/Linux.
  //
  // The tray icon path is resolved through the centralised pure
  // helper `resolveTrayIconPath` (see below) so the per-platform
  // branch lives at this single composition root rather than inside
  // `createTray`'s body — Requirement 5.6.
  _tray = createTray({
    compactWindow,
    scheduler,
    onExpand: () => openOrFocusExpanded(repositories, settings),
    onSettings: () => openOrFocusExpanded(repositories, settings, 'settings'),
    getIconPath: () =>
      resolveTrayIconPath(process.platform, resolveTrayResourcesRoot()),
    isAppQuitting,
  });
}

// ---------------------------------------------------------------------------
// Tray icon resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the tray icon asset for the given
 * platform and packaged-resources root.
 *
 * Branch table:
 *
 * - `platform === 'darwin'`
 *     → `<resourcesRoot>/tray-iconTemplate.png` (monochrome template
 *       PNG that AppKit recolours to match the menu-bar foreground).
 * - everything else (`win32`, `linux`, anything unrecognised)
 *     → `<resourcesRoot>/tray-icon.png` (full-colour PNG).
 *
 * Pure: derives its result solely from the arguments. Total: never
 * throws, even when `platform` is `''` or an unrecognised string
 * (falls through to the colour-icon branch — Requirement 12.6).
 *
 * Exported so the Property 6 PBT test can exercise every supported
 * platform branch without monkey-patching `process.platform` or
 * `process.resourcesPath`. See Requirements 5.4 / 5.5 / 5.6 / 12.6 /
 * 13.4 and design.md §`src/main/app.ts#getIconPath`.
 *
 * The caller is responsible for choosing `resourcesRoot`:
 *
 * - In a packaged app, the `extraResources` mappings declared in
 *   `electron-builder.yml` land under `process.resourcesPath`, so
 *   the caller passes that.
 * - In dev, `npm run icons` writes the assets into `<projectRoot>/build`,
 *   so the caller passes the project's `build/` folder.
 *
 * See {@link resolveTrayResourcesRoot} for the production policy
 * that picks between those two roots based on `app.isPackaged`.
 */
export function resolveTrayIconPath(
  platform: string,
  resourcesRoot: string,
): string {
  if (platform === 'darwin') {
    return path.join(resourcesRoot, 'tray-iconTemplate.png');
  }
  // win32 + linux + any unrecognised platform string fall back to
  // the colour icon. Requirement 5.5 / 12.6: linux behaves like
  // win32 here so the property test gets its third platform branch
  // without conditional skipping.
  return path.join(resourcesRoot, 'tray-icon.png');
}

/**
 * Pick the on-disk root that holds the tray icon assets for the
 * current process — `process.resourcesPath` in a packaged dmg /
 * NSIS installer, or `<projectRoot>/build` when running `npm run dev`.
 *
 * Kept separate from {@link resolveTrayIconPath} so the per-platform
 * branch stays purely a string-mapping function and the
 * environment-touching branch lives in a single, untested-but-trivial
 * helper.
 */
function resolveTrayResourcesRoot(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(__dirname, '..', '..', 'build');
}

// ---------------------------------------------------------------------------
// Expanded window singleton
// ---------------------------------------------------------------------------

/**
 * Open the expanded window, or focus it if it already exists and
 * hasn't been destroyed. Ensures only one expanded window is alive.
 *
 * Per Requirement 8.7 the existing-window path calls `show()`,
 * `focus()`, AND `moveTop()` so the window comes to the foreground
 * on the active Space and acquires keyboard focus on every supported
 * platform — `moveTop()` raises Z-order above non-`alwaysOnTop`
 * windows on the same Space (necessary on macOS where a hidden-
 * behind-Safari expanded window would otherwise stay buried), and
 * `focus()` shifts keyboard focus so the user can immediately type.
 * On the create branch, `createExpandedWindow` defers the first show
 * to the renderer's `ready-to-show` event and the new window is
 * always raised + focused at first paint, so the same posture is
 * achieved without a redundant explicit `focus()` here.
 *
 * If `tab` is provided, the renderer is notified to switch to that
 * tab via a webContents message.
 */
function openOrFocusExpanded(
  repositories: Repositories,
  fallbackSettings: AppSettings,
  tab?: 'network' | 'usage' | 'settings',
): void {
  if (_expandedWindow !== null && !_expandedWindow.isDestroyed()) {
    // The window may be hidden (close → hide guard). `show()` is a
    // no-op on an already-visible window and reveals a hidden one.
    _expandedWindow.show();
    _expandedWindow.focus();
    // Requirement 8.7: raise Z-order above other non-always-on-top
    // windows on the active Space. On macOS this is the difference
    // between the user seeing the dashboard immediately and the
    // dashboard staying buried behind Safari/Finder. Idempotent on
    // win32 / linux where `focus()` already implies a Z-order raise
    // on most window managers.
    _expandedWindow.moveTop();
    if (tab) {
      _expandedWindow.webContents.send('navigate-tab', tab);
    }
    return;
  }
  const settings = _settings ?? fallbackSettings;
  const expandedWindow = createExpandedWindow({
    controllerUrl: settings.controllerUrl,
    managementUrl: settings.managementInterface.url,
    settings: repositories.settings,
    session: session.defaultSession,
  });
  _expandedWindow = expandedWindow;

  // Subscribe the expanded window to the dashboard push channel.
  // Without this the renderer would only ever paint the snapshot it
  // gets from its initial `getDashboard()` call — every collector
  // tick, every node-switch verify cycle, and every config-switch
  // completion already calls `broadcastDashboard()` but those pushes
  // were silently dropped because only the compact window was a
  // subscriber. The `destroyed` listener inside `attachPushChannel`
  // takes care of removing the entry when the window closes.
  if (_dashboardService !== null) {
    _dashboardService.attachPushChannel(expandedWindow.webContents);
  }

  // Requirement 8.7: when a brand-new expanded window is created via
  // the tray menu (and the `ready-to-show` first paint has fired),
  // ensure it acquires keyboard focus and is raised above other
  // windows on the active Space. `createExpandedWindow` already
  // calls `show()` on `ready-to-show`; we chain `focus()` +
  // `moveTop()` so the same posture as the existing-window branch
  // applies on first creation too.
  expandedWindow.once('ready-to-show', () => {
    if (!expandedWindow.isDestroyed()) {
      expandedWindow.focus();
      expandedWindow.moveTop();
    }
  });

  // Close → hide-to-tray. Same posture as the compact window (see
  // tray.ts): a user-initiated close (X button, Alt+F4, Cmd+W) just
  // hides the window so the tray remains the single source of
  // truth for the app's "running" state. The window is only
  // actually destroyed when the user picks "退出" from the tray
  // menu, which calls `app.quit()` → `before-quit` flips
  // `_isQuitting` → `isAppQuitting()` returns `true` here and we
  // let the close cascade through to `closed`.
  expandedWindow.on('close', (event) => {
    if (!isAppQuitting() && !expandedWindow.isDestroyed()) {
      event.preventDefault();
      expandedWindow.hide();
    }
  });

  expandedWindow.on('closed', () => {
    _expandedWindow = null;
  });
  if (tab) {
    expandedWindow.webContents.once('did-finish-load', () => {
      expandedWindow.webContents.send('navigate-tab', tab);
    });
  }
}

function applyCompactWindowSize(input: import('./types').ResizeCompactWindowInput): void {
  if (_compactWindow === null || _compactWindow.isDestroyed()) {
    return;
  }
  // Renderer measures in CSS pixels (untouched by setZoomFactor); we
  // own the multiplication into device-independent pixels here so a
  // later zoom change can re-apply the size against the cached CSS
  // measurement without waiting for a re-render.
  const cssWidth = Math.round(input.width ?? COMPACT_AUTO_MAX_WIDTH);
  const cssHeight = Math.round(input.height);
  _lastCompactCssSize = {
    width: Math.max(COMPACT_AUTO_MIN_WIDTH, cssWidth),
    height: Math.max(COMPACT_AUTO_MIN_HEIGHT, cssHeight),
  };
  applyCompactPhysicalSize();
}

/**
 * Reconcile the compact window's physical (DIP) size with the most
 * recent CSS-pixel measurement and the live `appearance.compactZoom`.
 * No-ops when no measurement has been received yet.
 *
 * Called from:
 *   - `applyCompactWindowSize` (renderer auto-measure tick),
 *   - `applyCompactZoom` (settings change; re-stretch to new zoom).
 */
function applyCompactPhysicalSize(): void {
  if (_compactWindow === null || _compactWindow.isDestroyed()) {
    return;
  }
  // Fall back to the designed compact-window size when the renderer
  // has not yet reported its measurement. This makes a settings-side
  // zoom change (`applyCompactZoom`) work even before the first
  // `resizeCompactWindow` IPC tick lands.
  const cssSize = _lastCompactCssSize ?? {
    width: COMPACT_AUTO_MAX_WIDTH,
    height: COMPACT_DEFAULT_SIZE.height,
  };
  const zoom = currentCompactZoom();
  const nextWidth = Math.min(
    COMPACT_AUTO_MAX_WIDTH * COMPACT_MAX_ZOOM,
    Math.max(
      COMPACT_AUTO_MIN_WIDTH,
      Math.round(cssSize.width * zoom),
    ),
  );
  const nextHeight = Math.min(
    COMPACT_AUTO_MAX_HEIGHT * COMPACT_MAX_ZOOM,
    Math.max(
      COMPACT_AUTO_MIN_HEIGHT,
      Math.round(cssSize.height * zoom),
    ),
  );
  const size = _compactWindow.getSize();
  const currentWidth = size[0] ?? 360;
  const currentHeight = size[1] ?? COMPACT_DEFAULT_SIZE.height;
  // Tolerate ±1 DIP of jitter so a sub-pixel rounding wobble in the
  // renderer's measurement does not flap the window dimensions every
  // ResizeObserver tick. The renderer applies the same epsilon when
  // deciding whether to re-send the IPC.
  if (
    Math.abs(currentWidth - nextWidth) <= 1 &&
    Math.abs(currentHeight - nextHeight) <= 1
  ) {
    return;
  }

  // Compute the new X so the window's RIGHT edge stays fixed on screen.
  const pos = _compactWindow.getPosition();
  const currentX = pos[0] ?? 0;
  const currentY = pos[1] ?? 0;
  const nextX = currentX + currentWidth - nextWidth;

  const wasResizable = _compactWindow.isResizable();
  if (!wasResizable) {
    _compactWindow.setResizable(true);
  }

  // On Windows, `setBounds` on transparent frameless windows can be
  // unreliable. Split into `setPosition` + `setSize` for robustness.
  // We deliberately do NOT touch `setMaximumSize` here on every
  // tick — that causes Windows DWM to recompute window metrics and
  // visibly flap the right edge of the widget. The maximum size is
  // configured once at window creation
  // (`createCompactWindow` uses `COMPACT_DEFAULT_SIZE.width × COMPACT_MAX_ZOOM`)
  // and never narrowed afterwards, so a zoom-driven resize never
  // hits the limit anyway.
  _compactWindow.setPosition(nextX, currentY, false);
  _compactWindow.setSize(nextWidth, nextHeight, false);

  if (!wasResizable) {
    setTimeout(() => {
      if (_compactWindow && !_compactWindow.isDestroyed()) {
        _compactWindow.setResizable(false);
      }
    }, 100);
  }
}

/**
 * Coerce an arbitrary persisted `compactZoom` value to a finite
 * number in `[0.1, COMPACT_MAX_ZOOM]`. Pure, total, exported so the
 * Property 8 PBT test can drive it directly without touching the
 * module-level `_settings` handle.
 *
 * Spec mapping (Requirements 7.5a, 7.5b):
 *   - `raw` that is not a finite `number` (`undefined`, `null`,
 *     `NaN`, `±Infinity`, strings, objects, …) collapses to the
 *     designed default `1.0` BEFORE the clamp is applied.
 *   - Any finite `number` (positive, negative, or zero) is clamped
 *     into `[0.1, COMPACT_MAX_ZOOM]` via `min(MAX, max(0.1, raw))`.
 *
 * The lower bound is `0.1` (widened from `1`) so a future Settings
 * UI can offer sub-100% zoom for users with high-DPI displays
 * without rejecting otherwise-valid persisted rows. The upper
 * bound is the existing `COMPACT_MAX_ZOOM = 2`.
 */
export function clampCompactZoom(raw: unknown): number {
  const base =
    typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
  return Math.min(COMPACT_MAX_ZOOM, Math.max(0.1, base));
}

/**
 * Read the current compact zoom factor, clamped to the supported
 * `[0.1, COMPACT_MAX_ZOOM]` range. Falls back to `1` when settings
 * have not been loaded yet (extremely early boot) or when the
 * persisted value fails the finite-number predicate. Delegates to
 * the pure {@link clampCompactZoom} helper.
 */
function currentCompactZoom(): number {
  return clampCompactZoom(_settings?.appearance?.compactZoom);
}

/**
 * Re-apply the compact window's zoom factor and physical (DIP)
 * size after a zoom change.
 *
 * Per Requirement 7.5 the main process invokes
 * `webContents.setZoomFactor(currentCompactZoom())` on every
 * `did-finish-load` AND on every change to `appearance.compactZoom`,
 * so the renderer's rasterisation scale is always observably equal
 * to the resolved zoom value (a finite number in
 * `[0.1, COMPACT_MAX_ZOOM]`). The companion
 * {@link applyCompactPhysicalSize} call grows the BrowserWindow's
 * device-pixel footprint to match.
 *
 * Idempotent; safe to call repeatedly.
 */
function applyCompactZoom(): void {
  if (_compactWindow === null || _compactWindow.isDestroyed()) {
    return;
  }
  const zoom = currentCompactZoom();
  // Defensive guard: `setZoomFactor` throws on a destroyed
  // webContents. The window destruction guard above is not
  // sufficient because the BrowserWindow's `webContents` can be
  // disposed independently in some edge cases.
  if (!_compactWindow.webContents.isDestroyed()) {
    _compactWindow.webContents.setZoomFactor(zoom);
  }
  applyCompactPhysicalSize();
}

/**
 * Apply a validated `AppSettingsPatch` to the persisted settings and
 * return the merged value.
 *
 * v1 semantics (richer logic — CSP rebuild, scheduler interval reload
 * — lands in task 9.1):
 *   - Top-level scalar / array fields overwrite their predecessors.
 *   - Nested `routerHealth` and `refreshIntervals` are spread on top
 *     of the previous values so a partial update (e.g. only
 *     `refreshIntervals.networkMs`) does not blank out the rest of
 *     the nested object.
 *   - `collectors` is merged at the per-key level for the same reason.
 *
 * The merged value is persisted via `writeAppSettings` and the
 * in-memory `_settings` handle is updated so subsequent
 * `getSettings()` calls see the new value.
 */
function applyAppSettingsPatch(
  repositories: Repositories,
  patch: Partial<AppSettings>,
): AppSettings {
  const current = _settings ?? loadOrSeedAppSettings(repositories);
  const next: AppSettings = {
    ...current,
    ...patch,
    routerHealth: {
      ...current.routerHealth,
      ...(patch.routerHealth ?? {}),
    },
    refreshIntervals: {
      ...current.refreshIntervals,
      ...(patch.refreshIntervals ?? {}),
    },
    collectors: {
      ...current.collectors,
      ...(patch.collectors ?? {}),
    },
    cliproxy: {
      ...current.cliproxy,
      ...(patch.cliproxy ?? {}),
    },
    appearance: {
      ...current.appearance,
      ...(patch.appearance ?? {}),
    },
    kiroTokenRefresh: {
      ...current.kiroTokenRefresh,
      ...(patch.kiroTokenRefresh ?? {}),
    },
  };
  writeAppSettings(repositories.settings, next);
  _settings = next;

  // Broadcast `settings.updated` so every live renderer can react
  // (e.g. the appearance switcher applies a new theme without a
  // restart). We push AFTER the persist+memoize step so any window
  // that reaches back through `getSettings()` synchronously inside
  // its handler sees the same value that was broadcast. Destroyed
  // windows are skipped defensively.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('settings.updated', next);
    }
  }

  // Side-effect: sync the OS login-item setting when `autostart` changes.
  if (patch.autostart !== undefined) {
    setAutostart(next.autostart);
  }

  // Side-effect: re-apply compact-window zoom whenever
  // `appearance.compactZoom` changes. The renderer is unaffected by
  // the renderer-side `appearance` push (it never reads compactZoom);
  // the actual rasterisation scale is owned by the main process via
  // `webContents.setZoomFactor`, paired with a corresponding
  // BrowserWindow physical resize so the widget keeps the same
  // CSS-pixel layout but renders into more device pixels.
  const appearancePatch = patch.appearance;
  const zoomChanged =
    appearancePatch !== undefined &&
    'compactZoom' in appearancePatch &&
    appearancePatch.compactZoom !== current.appearance.compactZoom;
  if (zoomChanged) {
    applyCompactZoom();
  }

  // Side-effect: rebuild CSP connect-src and per-window will-navigate
  // allowlists when the controllerUrl OR the managementInterface
  // changes. Both inputs feed the same renderer allowlist computation
  // (see network-quick-actions/design.md §CSP / will-navigate Update,
  // Requirements 13.4 + 13.5):
  //   - connect-src is the union of `controllerUrl` and (when
  //     non-empty) `managementInterface.url`, deduplicated;
  //   - will-navigate adds the renderer's own origin.
  //
  // `applyCspHeaders` is idempotent (it tears down the prior listener
  // and installs a fresh one). `applyNavigationGuards` is now
  // idempotent too — it removes any prior `will-navigate` guard it
  // installed before re-attaching, so re-invoking on every live
  // `BrowserWindow` does not stack listeners.
  const controllerChanged = patch.controllerUrl !== undefined;
  const managementChanged = patch.managementInterface !== undefined;
  if (controllerChanged || managementChanged) {
    const {
      applyCspHeaders,
      applyNavigationGuards,
      computeRendererAllowedOrigins,
    } = require('./windows') as typeof import('./windows');
    const { connect: allowedConnect, navigate: allowedNavigate } =
      computeRendererAllowedOrigins({
        controllerUrl: next.controllerUrl,
        managementUrl: next.managementInterface.url,
      });
    // TODO(v1.1): cpa-quota-import — when real provider adapters land
    // (Claude Code, Codex, Gemini CLI, Antigravity), the following
    // origins must be added to the `connect-src` allowlist:
    //   - https://api.anthropic.com (Claude Code quota)
    //   - https://chatgpt.com (Codex quota; existing Codex remote path)
    //   - https://cloudcode-pa.googleapis.com (Gemini CLI quota)
    //   - https://daily-cloudcode-pa.googleapis.com (Antigravity quota)
    //   - https://daily-cloudcode-pa.sandbox.googleapis.com (Antigravity sandbox)
    // v1 placeholder adapters issue zero outbound HTTPS calls so no
    // allowlist change is required for the Foundation Phase.
    applyCspHeaders(session.defaultSession, allowedConnect);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        applyNavigationGuards(w, allowedNavigate);
      }
    }
  }

  // Side-effect: update scheduler task intervals when refreshIntervals changes.
  if (patch.refreshIntervals !== undefined && _scheduler !== null) {
    // The scheduler stores intervalMs per task at registration time
    // and doesn't expose a public setter. We work around this by
    // reaching into the tasks' `getIntervalMs` closures that read
    // `_settings` live — the actual delay computation happens in the
    // collector task factories via their `getIntervalMs` callback.
    // The chained-setTimeout design means the NEXT fire will
    // naturally pick up the new interval once the current tick ends.
  }

  // Side-effect: collectors on/off change takes effect on the next
  // usage tick automatically since the task reads _settings live.

  return next;
}

/**
 * Crash handler invoked from {@link main} when {@link boot} throws or
 * any later top-level error escapes. Surfaces a fallback error dialog
 * (when Electron is still alive) and tears the process down so we
 * don't leak a half-initialised state. Always exits non-zero so the
 * supervising shell or Windows event log records the failure.
 */
function reportFatalError(error: unknown): void {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  // eslint-disable-next-line no-console
  console.error('[monitor] fatal boot error:', error);
  try {
    if (app !== undefined && app.isReady()) {
      dialog.showErrorBox('Monitor failed to start', message);
    }
  } catch {
    // showErrorBox itself throwing is non-recoverable; fall through
    // to app.quit() below.
  }
  try {
    app.quit();
  } catch {
    // If Electron is gone (e.g. test harness), force-exit.
    process.exit(1);
  }
}

/**
 * macOS Dock-activate handler (also fires when the app is re-launched
 * with no windows open via `open -a Monitor`).
 *
 * Requirement 8.4 distinguishes two states:
 *
 *   - Compact_Window exists and is not destroyed → call `.show()`
 *     (handles the "hidden via tray menu, user wants it back" case
 *     without rebuilding the window).
 *   - Compact_Window does not exist or has been destroyed → recreate
 *     it (handles the "all windows closed" case the macOS app
 *     delegate fires `activate` for).
 *
 * The recreate branch is gated on `_settings` and `_repositories` so
 * an `activate` that fires before {@link boot} finishes (rare in
 * practice — `whenReady().then(boot)` resolves before macOS emits
 * `activate`) is a no-op rather than a crash.
 *
 * Harmless on Windows / Linux because `activate` is only fired by the
 * macOS app delegate.
 */
function handleActivate(): void {
  // Existing-and-alive: show the hidden compact window.
  if (_compactWindow !== null && !_compactWindow.isDestroyed()) {
    _compactWindow.show();
    return;
  }
  // Destroyed-or-missing: recreate. Requires the boot sequence to
  // have published the live settings + repositories.
  if (_settings === null || _repositories === null) return;
  _compactWindow = createCompactWindow({
    controllerUrl: _settings.controllerUrl,
    managementUrl: _settings.managementInterface.url,
    settings: _repositories.settings,
    session: session.defaultSession,
  });
  _compactWindow.webContents.once('did-finish-load', () => {
    applyCompactZoom();
  });
}

/**
 * `window-all-closed` handler.
 *
 * Per Requirement 8.3 this listener never calls `app.quit()` —
 * neither on `darwin`, nor on `win32`, nor on `linux`. The compact
 * window's `close` event is intercepted by the tray (hide-instead-of-
 * quit) so the OS rarely emits `window-all-closed` in the first
 * place; when it does (e.g. the expanded window is the last live
 * BrowserWindow and the user closes it via Cmd-W on macOS), the app
 * stays alive in the menu bar / system tray and the user reaches the
 * compact window again via the tray's "显示/隐藏" entry or, on macOS,
 * via Dock activate ({@link handleActivate} re-creates the compact
 * window).
 *
 * Tray menu's "退出" entry is the single supported quit path: it
 * calls `app.quit()` directly which fires `before-quit` first
 * (flipping `_isQuitting`), then lets the window-close cascade
 * actually terminate the process.
 */
function handleWindowAllClosed(): void {
  // Intentionally empty across every platform (Requirement 8.3).
}

/**
 * Entry point invoked by `src/main/index.ts`. Registers the lifecycle
 * listeners and schedules {@link boot} to run once Electron's app
 * subsystem is ready.
 *
 * Idempotent guard included for completeness: the supervising
 * `index.ts` only calls `main()` once.
 */
let _started = false;
export function main(): void {
  if (_started) return;
  _started = true;

  Menu.setApplicationMenu(null);

  app.on('window-all-closed', handleWindowAllClosed);
  app.on('activate', handleActivate);

  app.whenReady().then(boot).catch(reportFatalError);
}
