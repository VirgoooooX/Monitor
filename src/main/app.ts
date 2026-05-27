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
  const appearance = {
    colorMode: raw.appearance?.colorMode ?? ('dark' as const),
    compactTheme,
    fontScale: raw.appearance?.fontScale ?? 1,
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

const COMPACT_AUTO_MIN_HEIGHT = 40;
const COMPACT_AUTO_MAX_HEIGHT = 720;
const COMPACT_AUTO_MIN_WIDTH = 56;
const COMPACT_AUTO_MAX_WIDTH = 360;

async function boot(): Promise<void> {
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
  _tray = createTray({
    compactWindow,
    scheduler,
    onExpand: () => openOrFocusExpanded(repositories, settings),
    onSettings: () => openOrFocusExpanded(repositories, settings, 'settings'),
    getIconPath: () => {
      // In packaged app, extraResources lands in process.resourcesPath.
      // In dev, use the build/ folder relative to project root.
      if (app.isPackaged) {
        return path.join(process.resourcesPath, 'icon.ico');
      }
      return path.join(__dirname, '..', '..', 'build', 'icon.ico');
    },
  });
}

// ---------------------------------------------------------------------------
// Expanded window singleton
// ---------------------------------------------------------------------------

/**
 * Open the expanded window, or focus it if it already exists and
 * hasn't been destroyed. Ensures only one expanded window is alive.
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
    _expandedWindow.show();
    _expandedWindow.focus();
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
  const nextWidth = Math.min(
    COMPACT_AUTO_MAX_WIDTH,
    Math.max(COMPACT_AUTO_MIN_WIDTH, Math.round(input.width ?? 360)),
  );
  const nextHeight = Math.min(
    COMPACT_AUTO_MAX_HEIGHT,
    Math.max(COMPACT_AUTO_MIN_HEIGHT, Math.round(input.height)),
  );
  const size = _compactWindow.getSize();
  const currentWidth = size[0] ?? 360;
  const currentHeight = size[1] ?? COMPACT_DEFAULT_SIZE.height;
  if (currentWidth === nextWidth && currentHeight === nextHeight) {
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

  // Temporarily widen / narrow the maxWidth constraint so Electron
  // does not silently clamp the requested width.
  _compactWindow.setMaximumSize(
    Math.max(COMPACT_AUTO_MAX_WIDTH, nextWidth),
    COMPACT_AUTO_MAX_HEIGHT,
  );

  // On Windows, `setBounds` on transparent frameless windows can be
  // unreliable. Split into `setPosition` + `setSize` for robustness.
  _compactWindow.setPosition(nextX, currentY, false);
  _compactWindow.setSize(nextWidth, nextHeight, false);

  // Restore the maxWidth constraint for the new mode.
  _compactWindow.setMaximumSize(
    Math.max(COMPACT_AUTO_MAX_WIDTH, nextWidth),
    COMPACT_AUTO_MAX_HEIGHT,
  );

  if (!wasResizable) {
    setTimeout(() => {
      if (_compactWindow && !_compactWindow.isDestroyed()) {
        _compactWindow.setResizable(false);
      }
    }, 100);
  }
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
    managementUrl: _settings.managementInterface.url,
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

  Menu.setApplicationMenu(null);

  app.on('window-all-closed', handleWindowAllClosed);
  app.on('activate', handleActivate);

  app.whenReady().then(boot).catch(reportFatalError);
}
