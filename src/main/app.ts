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

import { app, BrowserWindow, dialog, safeStorage, session, Tray } from 'electron';

import { setAutostart } from './autostart';
import { registerIpcHandlers, type IpcRegistry } from './ipc';
import {
  initSecrets,
  type SecretsStore,
} from './security/secrets';
import {
  createDashboardService,
  type DashboardService,
} from './services/dashboard.service';
import {
  createOpenClashClient,
  type OpenClashClient,
} from './services/openclash.service';
import {
  createSwitchNodeService,
  type SwitchNodeService,
} from './services/openclash.switch';
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
import { createCompactWindow, createExpandedWindow } from './windows';
import { createTray } from './tray';
import {
  createCodexCollector,
} from './collectors/usage/codex.collector';
import {
  createGeminiCollector,
} from './collectors/usage/gemini.collector';
import {
  createAntigravityCollector,
} from './collectors/usage/antigravity.collector';
import {
  createOpenCodeCollector,
} from './collectors/usage/opencode.collector';
import {
  createDeepSeekCollector,
} from './collectors/usage/deepseek.collector';
import {
  persistCapabilityResult,
} from './collectors/usage/Collector';
import type { UsageCollector } from './collectors/usage/types';
import type { AppSettings } from './types';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Default settings seed
// ---------------------------------------------------------------------------

/**
 * The seed value persisted under `app.settings` on first launch.
 *
 * Mirrors design.md §Validation rules (controllerUrl format, probe
 * URL list, switch-verify delay) and design.md §Default intervals
 * (per-task tick rates).
 */
function buildDefaultAppSettings(): AppSettings {
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
  };
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
    return existing;
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
let _dashboardService: DashboardService | null = null;
let _switchNodeService: SwitchNodeService | null = null;
let _ipcRegistry: IpcRegistry | null = null;

async function boot(): Promise<void> {
  // 1. Open the application database and apply migrations.
  const db = openDatabase();
  runMigrations(db);
  _db = db;

  // 2. Build the typed repositories bundle (settings, secrets,
  //    samples, usage events, collector_health).
  const repositories = createRepositories(db);
  _repositories = repositories;

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
    settings: repositories.settings,
    session: session.defaultSession,
  });
  _compactWindow = compactWindow;

  // 8. Construct the OpenClash HTTP client and its derived services.
  //    `controllerUrl` is read live so user edits in Settings (task
  //    9.1) take effect on the very next request without rebuilding
  //    the client. Secrets are sourced through the singleton
  //    initialised in step 3.
  const openClashClient = createOpenClashClient({
    controllerUrl: () => (_settings ?? settings).controllerUrl,
  });
  _openClashClient = openClashClient;

  const dashboardService = createDashboardService({
    repositories,
    getControllerUrl: () => (_settings ?? settings).controllerUrl,
    getProbeUrls: () => (_settings ?? settings).probeUrls,
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
  });

  // Diagnostics service (task 9.3)
  const diagnosticsService = createDiagnosticsService({
    settings: repositories.settings,
    collectorHealth: repositories.collectorHealth,
    getSecretValues: () => {
      try {
        const { secrets: sec } = require('./security/secrets') as typeof import('./security/secrets');
        // Collect all known secret keys
        const keys = ['openclash.controllerSecret', 'deepseek_api_key'];
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

  scheduler.register(
    createOpenClashCollectorTask({
      repositories: {
        networkSamples: repositories.networkSamples,
        openclashSnapshots: repositories.openClashSnapshots,
      },
      client: openClashClient,
      getSettings: () => _settings ?? settings,
      getIntervalMs: () => (_settings ?? settings).refreshIntervals.openclashMs,
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
    getSettings: () => _settings ?? settings,
    updateSettings: (patch) => applyAppSettingsPatch(repositories, patch),
    updateSecret: (input) => {
      const { secrets: sec } = require('./security/secrets') as typeof import('./security/secrets');
      // Allowlist of secret keys the renderer is permitted to write.
      const ALLOWED_KEYS = ['openclash.controllerSecret'];
      if (!ALLOWED_KEYS.includes(input.key)) {
        throw new Error(`updateSecret: unknown key '${input.key}'`);
      }
      sec.set(input.key, input.value);
    },
    getUsageSummary: (range) => usageService.getUsageSummary({ range }),
    getDiagnostics: () => diagnosticsService.export(),
    runRefreshNow: async () => {
      // Run all collectors immediately
      await Promise.allSettled([
        scheduler.runNow('network'),
        scheduler.runNow('openclash'),
        scheduler.runNow('nodeScan'),
      ]);
    },
    openExpanded: () => openOrFocusExpanded(repositories, settings),
  });

  // 10. Register usage collector scheduler task.
  //     Runs all enabled usage collectors every `usageMs` interval.
  scheduler.register({
    id: 'usage',
    intervalMs: settings.refreshIntervals.usageMs,
    async fn() {
      const currentSettings = _settings ?? settings;
      const { secrets: sec } = require('./security/secrets') as typeof import('./security/secrets');

      // Build collectors list
      const collectors: Array<{ id: string; create: () => UsageCollector }> = [
        { id: 'codex', create: () => createCodexCollector() },
        { id: 'gemini', create: () => createGeminiCollector() },
        { id: 'antigravity', create: () => createAntigravityCollector() },
        { id: 'opencode', create: () => createOpenCodeCollector() },
        {
          id: 'deepseek',
          create: () => createDeepSeekCollector({ getSecret: (k) => sec.get(k) }),
        },
      ];

      await Promise.allSettled(
        collectors.map(async ({ id, create }) => {
          const toggle = currentSettings.collectors[id];
          if (toggle && !toggle.enabled) {
            persistCapabilityResult(repositories.settings, id, { status: 'disabled' });
            return;
          }
          const collector = create();
          const now = Date.now();

          // Capability check
          let capResult = await collector.capabilityCheck();
          if (capResult.status === 'unavailable' || capResult.status === 'disabled') {
            persistCapabilityResult(repositories.settings, id, capResult);
            repositories.collectorHealth.recordFailure(id, now, `skipped: ${capResult.status}`);
            return;
          }

          // Run tick
          try {
            await collector.tick({
              usageEvents: repositories.usageEvents,
              now: () => Date.now(),
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            repositories.collectorHealth.recordFailure(id, now, msg);
            persistCapabilityResult(repositories.settings, id, capResult);
            return;
          }

          // "ok with all zeros" guard
          if (capResult.status === 'ok') {
            const fromTs = now - 300_000;
            const aggregate = repositories.usageEvents.aggregateForProvider(id, { fromTs, toTs: now });
            if (aggregate.eventCount === 0) {
              capResult = { status: 'unavailable', reason: 'ok 但无数据产出' };
            }
          }

          persistCapabilityResult(repositories.settings, id, capResult);
          repositories.collectorHealth.recordSuccess(id, Date.now());
        }),
      );
    },
  });

  // 11. System tray. Holds the app lifecycle on Windows/Linux.
  _tray = createTray({
    compactWindow,
    scheduler,
    onExpand: () => openOrFocusExpanded(repositories, settings),
    onSettings: () => openOrFocusExpanded(repositories, settings),
    getIconPath: () => path.join(__dirname, '..', '..', 'build', 'tray-icon.png'),
  });
}

// ---------------------------------------------------------------------------
// Expanded window singleton
// ---------------------------------------------------------------------------

/**
 * Open the expanded window, or focus it if it already exists and
 * hasn't been destroyed. Ensures only one expanded window is alive.
 */
function openOrFocusExpanded(
  repositories: Repositories,
  fallbackSettings: AppSettings,
): void {
  if (_expandedWindow !== null && !_expandedWindow.isDestroyed()) {
    _expandedWindow.show();
    _expandedWindow.focus();
    return;
  }
  const settings = _settings ?? fallbackSettings;
  const expandedWindow = createExpandedWindow({
    controllerUrl: settings.controllerUrl,
    settings: repositories.settings,
    session: session.defaultSession,
  });
  _expandedWindow = expandedWindow;
  expandedWindow.on('closed', () => {
    _expandedWindow = null;
  });
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
  };
  writeAppSettings(repositories.settings, next);
  _settings = next;

  // Side-effect: sync the OS login-item setting when `autostart` changes.
  if (patch.autostart !== undefined) {
    setAutostart(next.autostart);
  }

  // Side-effect: rebuild CSP connect-src when controllerUrl changes.
  // The next request from the renderer will use the new origin; CSP
  // headers are applied per-request in the session handler so updating
  // the live _settings is sufficient — the header callback reads it.

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
 * Re-create the compact window if all windows have been closed and
 * the user re-activates the app (the standard macOS Dock pattern).
 *
 * Harmless on Windows / Linux because `activate` is only fired by the
 * macOS app delegate.
 */
function handleActivate(): void {
  if (BrowserWindow.getAllWindows().length > 0) return;
  if (_settings === null || _repositories === null) return;
  _compactWindow = createCompactWindow({
    controllerUrl: _settings.controllerUrl,
    settings: _repositories.settings,
    session: session.defaultSession,
  });
}

/**
 * On Windows and Linux the application normally quits when the last
 * window closes. We override that here because the tray (task 9.6)
 * owns the application's lifecycle: closing the compact window only
 * hides it. macOS already keeps the process alive by convention.
 */
function handleWindowAllClosed(): void {
  // Intentionally empty. Tray menu's "退出" entry calls `app.quit()`
  // explicitly when the user wants to exit (task 9.6).
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

  app.on('window-all-closed', handleWindowAllClosed);
  app.on('activate', handleActivate);

  app.whenReady().then(boot).catch(reportFatalError);
}
