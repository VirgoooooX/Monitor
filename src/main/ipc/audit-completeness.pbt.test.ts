// Feature: network-quick-actions, Property 6: Audit completeness — exactly two rows per flow, end before release.
//
// Validates Requirements 8.1, 8.2, 9.4.
//
// Property 6 (from network-quick-actions/design.md §Correctness Properties):
//
//   For arbitrary inputs (varying writeSucceeds, verifyOutcome, lock
//   contention) driving the `switchOpenClashConfig` IPC orchestrator
//   end-to-end:
//
//     Case A — lock acquires successfully → orchestrator runs the
//              full flow → exactly TWO rows land in the
//              `openclash_config_changes` table (one `'start'`,
//              one `'end'`). The `'start'` row is written BEFORE any
//              `switchActiveConfig` call into the management client;
//              the `'end'` row is written BEFORE the lock is
//              released.
//
//     Case B — lock acquire fails (already held) → orchestrator
//              returns `{ ok: false, error: { code:
//              'switch_in_progress' } }` and ZERO rows are written
//              to `openclash_config_changes`. No lock release is
//              issued (the orchestrator never acquired a token).
//
// References:
//   - .kiro/specs/network-quick-actions/design.md
//       §Property 6 (Audit completeness)
//       §`switchOpenClashConfig` handler — orchestration steps
//       §`openclash.config.audit.ts` — Config Switch Audit Writer
//   - .kiro/specs/network-quick-actions/requirements.md
//       Requirement 8.1 (start row at flow start)
//       Requirement 8.2 (end row carries result + duration)
//       Requirement 9.4 (state cleared after audit row, not before)
//
// Strategy
// --------
//
//   * `electron` is mocked so `ipcMain.handle` captures the
//     registered handler into a map, lets us invoke the
//     `switchOpenClashConfig` handler directly without spinning up
//     an Electron `BrowserWindow` / `webContents` / IPC bridge.
//   * The audit writer is the real
//     `createConfigSwitchAuditService` against an in-memory
//     better-sqlite3 database — only the calls themselves are
//     traced via a thin wrapper, so the test asserts on actual SQL
//     row counts rather than mock invocations.
//   * The switch lock and management client are fakes that record
//     a strict ordered trace of every operation. The fake lock can
//     succeed or fail at acquire(); the fake management client
//     drives writeSucceeds + verifyOutcome combinations.
//   * The dashboard service is a no-op stub (broadcastDashboard
//     fires inside a `setTimeout(..., 100).unref()` and is
//     irrelevant to Property 6).
//   * Run >= 100 cases per fast-check property contract.

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Mock `electron` — `ipcMain.handle` captures handlers into a map.
// ---------------------------------------------------------------------------
//
// The mock factory must NOT close over module-scope variables that
// are only initialised after `await import` calls below — vitest
// hoists `vi.mock()` to the top of the module, so the factory body
// runs before any other top-level statement. We therefore stash the
// handler map on `globalThis` and resolve it lazily inside the
// factory's closures.

type CapturedHandler = (event: unknown, payload: unknown) => Promise<unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __nqa_property6_handlers__: Map<string, CapturedHandler> | undefined;
}

vi.mock('electron', () => {
  const getMap = (): Map<string, CapturedHandler> => {
    if (globalThis.__nqa_property6_handlers__ === undefined) {
      globalThis.__nqa_property6_handlers__ = new Map<
        string,
        CapturedHandler
      >();
    }
    return globalThis.__nqa_property6_handlers__;
  };
  return {
    ipcMain: {
      handle(channel: string, handler: CapturedHandler) {
        getMap().set(channel, handler);
      },
      removeHandler(channel: string) {
        getMap().delete(channel);
      },
    },
  };
});

const ipcHandlers: Map<string, CapturedHandler> = (() => {
  if (globalThis.__nqa_property6_handlers__ === undefined) {
    globalThis.__nqa_property6_handlers__ = new Map<string, CapturedHandler>();
  }
  return globalThis.__nqa_property6_handlers__;
})();

// ---------------------------------------------------------------------------
// Lazy imports — must come AFTER the `vi.mock('electron', ...)` call so the
// `./index` module's `import { ipcMain } from 'electron'` picks up the mock.
// ---------------------------------------------------------------------------

let Database: typeof import('better-sqlite3');
let canRun = true;
try {
  Database = (await import('better-sqlite3')).default;
  // Probe — when `better-sqlite3` was compiled for Electron its
  // NODE_MODULE_VERSION will not match the test runner; skip in
  // that case (same pattern used by the other native-module PBTs).
  const probe = new Database(':memory:');
  probe.close();
} catch {
  canRun = false;
}

const { runMigrations } = await import('../store/migrations');
const { createRepositories } = await import('../store/repositories');
const { createConfigSwitchAuditService } = await import(
  '../services/openclash.config.audit'
);
const { registerIpcHandlers } = await import('./index');
const { DESKTOP_INVOKE_CHANNELS } = await import('./channels');

import type {
  ConfigSwitchResult,
  ManagementErrorCode,
  OpenClashManagementClient,
} from '../services/openclash.management.service';
import type {
  SwitchKind,
  SwitchLock,
  SwitchLockToken,
} from '../services/switch.lock';
import type {
  AppSettings,
  IpcResult,
} from '../types';
import type {
  RecordSwitchEndInput,
  RecordSwitchStartInput,
} from '../services/openclash.config.audit';

// ---------------------------------------------------------------------------
// Fixed values
// ---------------------------------------------------------------------------

const TARGET_PATH = '/etc/openclash/config/target.yaml';
const START_PATH = '/etc/openclash/config/start.yaml';

// ---------------------------------------------------------------------------
// Fake AppSettings — TARGET_PATH IS in the whitelist so the orchestrator's
// live-whitelist membership check passes.
// ---------------------------------------------------------------------------

function buildSettings(): AppSettings {
  return {
    controllerUrl: 'http://192.168.31.100:9090',
    primaryGroups: ['🚀 节点选择'],
    probeUrls: ['https://www.google.com/generate_204'],
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
    collectors: { codex: { enabled: true } },
    autostart: false,
    configSwitchVerifyWindowMs: 8_000,
    managementInterface: {
      kind: 'openclash-luci',
      url: 'http://192.168.31.100',
      requestTimeoutMs: 10_000,
      configFileWhitelist: [{ alias: 'target', path: TARGET_PATH }],
    },
  } as AppSettings;
}

// ---------------------------------------------------------------------------
// Trace event union — mirrors the design.md sequence diagram so the test's
// ordering assertions are exactly the design's ordering.
// ---------------------------------------------------------------------------

type TraceEventName =
  | 'lock_acquire'
  | 'lock_acquire_failed'
  | 'lock_release'
  | 'mgmt_readActiveConfigPath'
  | 'mgmt_switchActiveConfig'
  | 'audit_start'
  | 'audit_end';

interface TraceEvent {
  readonly name: TraceEventName;
}

// ---------------------------------------------------------------------------
// Property input
// ---------------------------------------------------------------------------

interface PropertyInput {
  /** false → fake lock returns null, simulating contention. */
  acquireSucceeds: boolean;
  /** Whether the management client's `switchActiveConfig` returns ok. */
  writeSucceeds: boolean;
  /** When `writeSucceeds === false`, drives the error code returned. */
  failureCode: ManagementErrorCode;
  /** Whether the pre-read of `readActiveConfigPath` throws. */
  preReadFails: boolean;
}

const failureCodeArb: fc.Arbitrary<ManagementErrorCode> = fc.constantFrom(
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
);

const propertyInputArb: fc.Arbitrary<PropertyInput> = fc.record({
  acquireSucceeds: fc.boolean(),
  writeSucceeds: fc.boolean(),
  failureCode: failureCodeArb,
  preReadFails: fc.boolean(),
});

// ---------------------------------------------------------------------------
// Per-case driver
// ---------------------------------------------------------------------------

interface CaseResult {
  readonly trace: ReadonlyArray<TraceEvent>;
  readonly auditRowCount: number;
  readonly auditStartCount: number;
  readonly auditEndCount: number;
  readonly ipcResult: IpcResult<ConfigSwitchResult>;
}

async function runOneCase(input: PropertyInput): Promise<CaseResult> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const repos = createRepositories(db);

  const trace: TraceEvent[] = [];
  const record = (name: TraceEventName): void => {
    trace.push({ name });
  };

  // ----- Real audit writer wrapped to record `audit_*` trace events.
  const realAudit = createConfigSwitchAuditService({
    repository: repos.openClashConfigChanges,
  });
  const tracingAudit = {
    recordSwitchStart(args: RecordSwitchStartInput): number | null {
      record('audit_start');
      return realAudit.recordSwitchStart(args);
    },
    recordSwitchEnd(args: RecordSwitchEndInput): void {
      record('audit_end');
      realAudit.recordSwitchEnd(args);
    },
  };

  // ----- Fake switch lock. Returns a token only when
  //       `input.acquireSucceeds`; mirrors the production contract
  //       that `release` is a no-op for unknown tokens (we just
  //       record the trace event regardless).
  const fakeLock: SwitchLock = {
    acquire(_kind: SwitchKind, _ttlMs: number): SwitchLockToken | null {
      if (!input.acquireSucceeds) {
        record('lock_acquire_failed');
        return null;
      }
      record('lock_acquire');
      return Object.freeze({
        id: 'fake-token-id',
        kind: Object.freeze({ type: 'config' as const }),
        acquiredAt: 1_700_000_000_000,
        deadlineAt: 1_700_000_016_000,
      });
    },
    release(_token: SwitchLockToken): void {
      record('lock_release');
    },
    snapshot() {
      return { config: null, nodes: [] };
    },
  };

  // ----- Fake management client.
  const fakeMgmt: OpenClashManagementClient = {
    async readActiveConfigPath(_opts) {
      record('mgmt_readActiveConfigPath');
      if (input.preReadFails) {
        // The orchestrator's pre-read is wrapped in a try/catch and
        // never aborts the flow; this branch exercises the
        // `startPath = null` path of the audit row.
        throw Object.freeze({
          code: 'network_error' as ManagementErrorCode,
          message: 'fake pre-read failure',
        });
      }
      return START_PATH;
    },
    async switchActiveConfig(args) {
      record('mgmt_switchActiveConfig');
      if (input.writeSucceeds) {
        return {
          ok: true,
          startPath: input.preReadFails ? null : START_PATH,
          targetPath: args.targetPath,
          finalPath: args.targetPath,
        };
      }
      return {
        ok: false,
        startPath: input.preReadFails ? null : START_PATH,
        targetPath: args.targetPath,
        finalPath: null,
        error: { code: input.failureCode, message: 'fake failure' },
      };
    },
    invalidateSession(): void {
      /* not exercised by Property 6 */
    },
  };

  // ----- No-op DashboardService (only `broadcastDashboard` is reached
  //       here, behind a setTimeout(100).unref() — even if it fires
  //       after the test ends, the no-op body cannot affect the trace).
  const fakeDashboard = {
    compute() {
      throw new Error('compute() not exercised in Property 6');
    },
    pushLatencySample(): void {
      /* unused */
    },
    setCurrentProbeResults(): void {
      /* unused */
    },
    setConsecutiveProbeFailures(): void {
      /* unused */
    },
    attachPushChannel(): () => void {
      return () => {
        /* unused */
      };
    },
    broadcastDashboard(): void {
      /* unused — see comment above */
    },
    hydrateSparklineFromDb(): void {
      /* unused */
    },
  };

  const settings = buildSettings();

  const inflight = new Map<string, never>();

  const registry = registerIpcHandlers({
    repositories: repos,
    // The dashboardService stub is structurally compatible — only
    // `broadcastDashboard` is reached. Cast through `unknown` to
    // satisfy `exactOptionalPropertyTypes` without exposing the
    // unused methods to the test.
    dashboardService: fakeDashboard as unknown as Parameters<
      typeof registerIpcHandlers
    >[0]['dashboardService'],
    openClashClient: {} as unknown as Parameters<
      typeof registerIpcHandlers
    >[0]['openClashClient'],
    switchNodeService: {} as unknown as Parameters<
      typeof registerIpcHandlers
    >[0]['switchNodeService'],
    openClashManagementClient: fakeMgmt,
    switchLock: fakeLock,
    configSwitchAudit: tracingAudit,
    inflightConfigSwitches: inflight as unknown as Parameters<
      typeof registerIpcHandlers
    >[0]['inflightConfigSwitches'],
    getSettings: () => settings,
    updateSettings: () => settings,
    updateSecret: () => {
      /* unused */
    },
    removeSecret: () => {
      /* unused */
    },
    getSecret: () => null,
  });

  try {
    const handler = ipcHandlers.get(
      DESKTOP_INVOKE_CHANNELS.switchOpenClashConfig,
    );
    if (handler === undefined) {
      throw new Error('switchOpenClashConfig handler was not registered');
    }
    const ipcResult = (await handler(
      {},
      { targetPath: TARGET_PATH },
    )) as IpcResult<ConfigSwitchResult>;

    const totalRow = db
      .prepare<[], { c: number }>(
        'SELECT COUNT(*) AS c FROM openclash_config_changes',
      )
      .get();
    const startRow = db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM openclash_config_changes WHERE status = 'start'",
      )
      .get();
    const endRow = db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM openclash_config_changes WHERE status = 'end'",
      )
      .get();

    return {
      trace,
      auditRowCount: totalRow?.c ?? 0,
      auditStartCount: startRow?.c ?? 0,
      auditEndCount: endRow?.c ?? 0,
      ipcResult,
    };
  } finally {
    registry.dispose();
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Trace assertion helpers
// ---------------------------------------------------------------------------

function indexOfFirst(
  trace: ReadonlyArray<TraceEvent>,
  name: TraceEventName,
): number {
  return trace.findIndex((e) => e.name === name);
}

function countOf(
  trace: ReadonlyArray<TraceEvent>,
  name: TraceEventName,
): number {
  return trace.reduce((acc, e) => acc + (e.name === name ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)(
  'switchOpenClashConfig — Property 6 (audit completeness)',
  () => {
    it('exactly two rows on every acquired path; zero rows on switch_in_progress', async () => {
      await fc.assert(
        fc.asyncProperty(propertyInputArb, async (input) => {
          const r = await runOneCase(input);

          if (!input.acquireSucceeds) {
            // ---------- Case B: lock contention ----------
            // Zero audit rows ever written.
            expect(r.auditRowCount).toBe(0);
            expect(r.auditStartCount).toBe(0);
            expect(r.auditEndCount).toBe(0);

            // No `audit_*` trace events.
            expect(countOf(r.trace, 'audit_start')).toBe(0);
            expect(countOf(r.trace, 'audit_end')).toBe(0);

            // No management-client calls — the orchestrator returns
            // immediately on contention without any side effect.
            expect(countOf(r.trace, 'mgmt_readActiveConfigPath')).toBe(0);
            expect(countOf(r.trace, 'mgmt_switchActiveConfig')).toBe(0);

            // No lock release (the orchestrator never owned a token).
            expect(countOf(r.trace, 'lock_release')).toBe(0);

            // IPC envelope carries the closed-set `switch_in_progress`
            // code (Requirement 9.2 / 16.2).
            expect(r.ipcResult.ok).toBe(false);
            if (!r.ipcResult.ok) {
              expect(r.ipcResult.error.code).toBe('switch_in_progress');
            }
            return;
          }

          // ---------- Case A: lock acquired ----------
          // Exactly TWO rows total: one `'start'`, one `'end'`.
          expect(r.auditRowCount).toBe(2);
          expect(r.auditStartCount).toBe(1);
          expect(r.auditEndCount).toBe(1);

          // Trace ordering invariants.
          const acquireIdx = indexOfFirst(r.trace, 'lock_acquire');
          const startIdx = indexOfFirst(r.trace, 'audit_start');
          const switchIdx = indexOfFirst(r.trace, 'mgmt_switchActiveConfig');
          const endIdx = indexOfFirst(r.trace, 'audit_end');
          const releaseIdx = indexOfFirst(r.trace, 'lock_release');

          // Every event we care about must be present exactly once.
          expect(acquireIdx).toBeGreaterThanOrEqual(0);
          expect(startIdx).toBeGreaterThanOrEqual(0);
          expect(switchIdx).toBeGreaterThanOrEqual(0);
          expect(endIdx).toBeGreaterThanOrEqual(0);
          expect(releaseIdx).toBeGreaterThanOrEqual(0);
          expect(countOf(r.trace, 'lock_acquire')).toBe(1);
          expect(countOf(r.trace, 'audit_start')).toBe(1);
          expect(countOf(r.trace, 'mgmt_switchActiveConfig')).toBe(1);
          expect(countOf(r.trace, 'audit_end')).toBe(1);
          expect(countOf(r.trace, 'lock_release')).toBe(1);

          // (1) lock_acquire happens first.
          expect(startIdx).toBeGreaterThan(acquireIdx);
          expect(switchIdx).toBeGreaterThan(acquireIdx);
          expect(endIdx).toBeGreaterThan(acquireIdx);
          expect(releaseIdx).toBeGreaterThan(acquireIdx);

          // (2) audit_start lands BEFORE the actual switchActiveConfig
          //     call (the design's "start before any client switch
          //     call" invariant — Requirement 8.1).
          expect(startIdx).toBeLessThan(switchIdx);

          // (3) audit_end lands BEFORE the lock is released
          //     (Requirement 9.4 — state cleared after audit row).
          expect(endIdx).toBeLessThan(releaseIdx);

          // (4) audit_end lands AFTER switchActiveConfig has returned
          //     (the end row carries the result code).
          expect(endIdx).toBeGreaterThan(switchIdx);

          // IPC envelope must succeed: the management client never
          // throws — every failure mode is carried inside the
          // returned `ConfigSwitchResult`.
          expect(r.ipcResult.ok).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('sanity: happy-path acquire + writeSucceeds writes one start + one end row', async () => {
      // Pin the canonical happy path so a regression in the
      // orchestrator that drops one of the audit rows is caught
      // with a deterministic example.
      const r = await runOneCase({
        acquireSucceeds: true,
        writeSucceeds: true,
        failureCode: 'http_error',
        preReadFails: false,
      });
      expect(r.auditStartCount).toBe(1);
      expect(r.auditEndCount).toBe(1);
      expect(r.ipcResult.ok).toBe(true);
    });

    it('sanity: contended acquire writes zero rows and returns switch_in_progress', async () => {
      const r = await runOneCase({
        acquireSucceeds: false,
        writeSucceeds: true,
        failureCode: 'http_error',
        preReadFails: false,
      });
      expect(r.auditRowCount).toBe(0);
      expect(r.ipcResult.ok).toBe(false);
      if (!r.ipcResult.ok) {
        expect(r.ipcResult.error.code).toBe('switch_in_progress');
      }
    });
  },
);
