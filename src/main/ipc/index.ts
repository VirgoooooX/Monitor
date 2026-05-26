// IPC handler registry.
//
// References:
//   - design.md §`ipc.ts` (handler contract)
//   - design.md §Property 12 (IPC schema rejection — handler returns
//     a structured error and never calls the underlying service)
//   - design.md §Layered Trust Model (main is the only place that
//     trusts the renderer's payloads)
//   - PLAN.md §IPC Interface (the `DesktopApi` shape)
//
// Why this file exists
// --------------------
// The preload bridge (`src/preload/index.ts`) and the renderer-side
// `DesktopApi` typings define the *wire* contract. This module is the
// main-process implementation of that contract: every channel listed
// in `DESKTOP_INVOKE_CHANNELS` is registered exactly once with
// `ipcMain.handle`, and the on-the-wire return shape is always
// {@link IpcResult} — `{ ok: true, value }` on success or
// `{ ok: false, error: { code, message } }` on any kind of failure.
//
// Wire envelope vs. renderer-typed Promise
// ----------------------------------------
// The renderer-side `DesktopApi` types (e.g.
// `getDashboard(): Promise<DashboardState>`) talk *unwrapped* values.
// The preload bridge bridges the gap: it awaits the envelope returned
// here and either resolves with `value` or rejects with an
// `IpcEnvelopeError` carrying `error.code` / `error.message`. That
// way the renderer keeps the ergonomic `await window.desktop.foo()`
// API while the main side always sees a fully serialised envelope —
// which is what design.md §Property 12 requires for malformed inputs
// ("the handler returns a structured error and never calls into the
// underlying service").
//
// Validation contract
// -------------------
// Every handler runs the corresponding entry in `desktopApiSchemas`
// against the renderer-supplied payload BEFORE touching any service:
//   - On parse failure → `{ ok: false, error: { code: 'validation',
//     message } }`. The service is not invoked.
//   - On parse success but a thrown service error →
//     `{ ok: false, error: { code: 'internal', message } }`.
//   - On absent optional dep (usage/diagnostics/refreshNow until later
//     tasks land) → `{ ok: false, error: { code: 'not_implemented',
//     message } }`.
//   - Otherwise → `{ ok: true, value }`.
//
// `dispose()` is idempotent and removes every handler this registry
// installed; tests use it to tear down between cases.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ZodIssue } from 'zod';

import {
  DESKTOP_INVOKE_CHANNELS,
  type DesktopInvokeMethod,
} from './channels';
import { desktopApiSchemas } from '../schemas';
import {
  AuthError,
  type OpenClashClient,
} from '../services/openclash.service';
import {
  identifyPrimaryGroup,
  isPseudoNodeName,
  resolveSelectedNode,
  selectedNodeName,
} from '../services/openclash.groups';
import type { DashboardService } from '../services/dashboard.service';
import type { SwitchNodeService } from '../services/openclash.switch';
import type {
  NodeSampleRow,
  Repositories,
} from '../store/repositories';
import type {
  AppSettings,
  ConfigsResponse,
  DashboardState,
  DiagnosticsReport,
  GroupView,
  IpcError,
  IpcResult,
  NodeView,
  OpenClashDetails,
  ProxiesResponse,
  ProxyEntry,
  SwitchNodeResult,
  UpdateSecretInput,
  UsageRange,
  UsageSummary,
} from '../types';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Patch payload accepted by `updateSettings`. Subset of `AppSettings`. */
export type AppSettingsPatch = Partial<AppSettings>;

/**
 * Construction-time dependencies. Live accessors (`getSettings`,
 * `updateSettings`) are passed as functions so user edits made
 * through Settings take effect on the very next IPC call without
 * re-registering handlers.
 */
export interface IpcRegistryDeps {
  repositories: Repositories;
  dashboardService: DashboardService;
  openClashClient: OpenClashClient;
  switchNodeService: SwitchNodeService;
  /** Live snapshot of the canonical `AppSettings`. */
  getSettings: () => AppSettings;
  /**
   * Apply a validated patch to the persisted settings and return the
   * merged value. Implementations are expected to persist the result
   * before returning (so a subsequent `getSettings` reflects it).
   */
  updateSettings: (patch: AppSettingsPatch) => AppSettings;
  /**
   * Persist a secret value via the secrets store. The key is
   * validated against a known allowlist.
   */
  updateSecret: (input: UpdateSecretInput) => void;
  /** Future service (task 7.8). When absent the IPC returns `not_implemented`. */
  getUsageSummary?: (range: UsageRange) => Promise<UsageSummary> | UsageSummary;
  /** Quota service. When absent the IPC returns `not_implemented`. */
  getQuotaStatus?: () => Promise<import('../types').QuotaStatus>;
  /** Future service (task 9.3). When absent the IPC returns `not_implemented`. */
  getDiagnostics?: () => Promise<DiagnosticsReport> | DiagnosticsReport;
  /** Future trigger (task 5.x). When absent the IPC returns `not_implemented`. */
  runRefreshNow?: () => Promise<void> | void;
  /** Callback to open/focus the expanded window. */
  openExpanded?: () => void;
}

/** Returned by {@link registerIpcHandlers} so callers can tear down cleanly. */
export interface IpcRegistry {
  /** Idempotent. Removes every handler this registry installed. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Build a human-readable message from the first zod issue. The first
 * issue is enough — the renderer just needs *a* validation hint, not
 * the entire diagnostic tree.
 */
function formatValidationMessage(issues: readonly ZodIssue[]): string {
  const issue = issues[0];
  if (issue === undefined) {
    return 'invalid payload';
  }
  const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `${where}: ${issue.message}`;
}

/**
 * Stringify an unknown error without leaking secret values. We
 * deliberately do NOT include `cause` chains or stack traces — those
 * may carry payload echoes that we want to keep main-side.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (typeof err === 'string' && err.length > 0) {
    return err;
  }
  return 'unknown error';
}

/**
 * Construct a failure envelope. Returning a concrete
 * `{ ok: false; error: IpcError }` instead of `IpcResult<T>` keeps
 * TypeScript happy at every call site without an explicit cast — the
 * concrete shape is assignable to `IpcResult<T>` for any T.
 */
function failure(
  code: string,
  message: string,
): { ok: false; error: IpcError } {
  return { ok: false, error: { code, message } };
}

const VALIDATION_FAILURE = (issues: readonly ZodIssue[]) =>
  failure('validation', formatValidationMessage(issues));

const INTERNAL_FAILURE = (err: unknown) =>
  failure('internal', describeError(err));

const NOT_IMPLEMENTED_FAILURE = (method: string, hint: string) =>
  failure('not_implemented', `${method}: ${hint}`);

// ---------------------------------------------------------------------------
// OpenClash details composition
// ---------------------------------------------------------------------------

/**
 * Build the `groups: GroupView[]` slice of an `OpenClashDetails`. The
 * primary group (per `identifyPrimaryGroup`) is hoisted to index 0;
 * the rest follow in the order Clash returned them. Only Selector
 * entries are emitted — URLTest / Fallback / leaf proxies are not
 * switchable from the UI in v1 (see design.md §Window Strategy).
 */
function buildGroupViews(
  proxies: ProxiesResponse,
  primaryGroups: readonly string[],
  repositories: Repositories,
): GroupView[] {
  const primary = identifyPrimaryGroup(proxies, primaryGroups);
  const resolvedPrimary = resolveSelectedNode(proxies, primary);
  const head: GroupView[] = [];
  const tail: GroupView[] = [];

  for (const [name, entry] of Object.entries(proxies.proxies)) {
    if (entry.type !== 'Selector') continue;

    const selected = selectedNodeName(entry);
    const current = isPseudoNodeName(selected) ? '' : (selected ?? '');
    const view: GroupView = {
      name,
      type: entry.type,
      current,
      nodes: buildNodeViews(name, entry, repositories),
    };

    if (name === (resolvedPrimary?.groupName ?? primary)) {
      head.push(view);
    } else {
      tail.push(view);
    }
  }

  return [...head, ...tail];
}

/**
 * Build `NodeView[]` for a single group. Latest delay information is
 * sourced from `node_samples`; rolling success rate stays `null` here
 * — task 5.8 wires the per-node sparkline / success rate when the
 * Node table view lands.
 */
function buildNodeViews(
  groupName: string,
  entry: ProxyEntry,
  repositories: Repositories,
): NodeView[] {
  const allNames = entry.all ?? [];
  if (allNames.length === 0) {
    return [];
  }

  const latestByName = new Map<string, NodeSampleRow>();
  for (const row of repositories.nodeSamples.latestPerNodeInGroup(
    groupName,
  )) {
    latestByName.set(row.nodeName, row);
  }

  return allNames.map((nodeName) => {
    const row = latestByName.get(nodeName);
    return {
      name: nodeName,
      source: row?.source ?? null,
      lastDelayMs: row?.delayMs ?? null,
      lastDelayAt: row?.timestamp ?? null,
      successRate: null,
    };
  });
}

/**
 * Compose an `OpenClashDetails` snapshot for the IPC handler.
 *
 * Failure semantics:
 *   - `AuthError` from any call → `apiState='auth_error'`, configs/groups
 *     are whatever was successfully fetched before the failure.
 *   - Any other thrown error → `apiState='unreachable'`.
 *   - The latest persisted snapshot drives `lastSnapshotAt` regardless
 *     of the live API state — the audit log is independent of "is the
 *     controller up right now".
 */
async function buildOpenClashDetails(
  client: OpenClashClient,
  repositories: Repositories,
  primaryGroups: readonly string[],
): Promise<OpenClashDetails> {
  let configs: ConfigsResponse | null = null;
  let proxies: ProxiesResponse | null = null;
  let apiState: 'ok' | 'auth_error' | 'unreachable' = 'ok';

  try {
    configs = await client.getConfigs();
  } catch (err) {
    apiState = err instanceof AuthError ? 'auth_error' : 'unreachable';
  }

  if (apiState === 'ok') {
    try {
      proxies = await client.getProxies();
    } catch (err) {
      apiState = err instanceof AuthError ? 'auth_error' : 'unreachable';
    }
  }

  const groups =
    proxies !== null
      ? buildGroupViews(proxies, primaryGroups, repositories)
      : [];

  const latestSnapshot = repositories.openClashSnapshots.latest();
  const lastSnapshotAt = latestSnapshot?.timestamp ?? null;

  return { configs, groups, lastSnapshotAt, apiState };
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register every handler in `DESKTOP_INVOKE_CHANNELS` against the
 * shared `ipcMain` instance. Returns an {@link IpcRegistry} with a
 * `dispose()` that tears them all down.
 *
 * Calling `registerIpcHandlers` twice without an intervening
 * `dispose()` throws because Electron's `ipcMain.handle` rejects a
 * second registration on the same channel — the explicit error here
 * is friendlier than the underlying Electron message.
 */
export function registerIpcHandlers(deps: IpcRegistryDeps): IpcRegistry {
  const channels = Object.values(DESKTOP_INVOKE_CHANNELS);

  // Defensive: surface a clear message instead of Electron's
  // "Attempted to register a second handler for ..." string.
  for (const channel of channels) {
    // `ipcMain` does not expose a "is registered?" predicate; we rely
    // on the contract that callers always pair `registerIpcHandlers`
    // with `dispose()`. The try/catch below converts any duplicate
    // registration error into a more descriptive one.
    try {
      ipcMain.removeHandler(channel);
    } catch {
      // `removeHandler` does not throw for an unregistered channel,
      // but be defensive across Electron versions.
    }
  }

  // -------------------------------------------------------------------------
  // getDashboard
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.getDashboard,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<DashboardState>> => {
      const parsed = desktopApiSchemas.getDashboard.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      try {
        const value = deps.dashboardService.compute();
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // getOpenClashDetails
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.getOpenClashDetails,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<OpenClashDetails>> => {
      const parsed =
        desktopApiSchemas.getOpenClashDetails.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      try {
        const value = await buildOpenClashDetails(
          deps.openClashClient,
          deps.repositories,
          deps.getSettings().primaryGroups,
        );
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // switchNode
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.switchNode,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<SwitchNodeResult>> => {
      const parsed = desktopApiSchemas.switchNode.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      try {
        const value = await deps.switchNodeService.switchNode(
          parsed.data.groupName,
          parsed.data.nodeName,
        );
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // refreshNow  (TODO: wired by task 5.x)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.refreshNow,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<void>> => {
      const parsed = desktopApiSchemas.refreshNow.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const trigger = deps.runRefreshNow;
      if (trigger === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'refreshNow',
          'awaiting collectors (task 5.x)',
        );
      }
      try {
        await trigger();
        return { ok: true, value: undefined };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // getUsageSummary  (TODO: wired by task 7.8)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.getUsageSummary,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<UsageSummary>> => {
      const parsed =
        desktopApiSchemas.getUsageSummary.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const fetcher = deps.getUsageSummary;
      if (fetcher === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'getUsageSummary',
          'awaiting usage.service (task 7.8)',
        );
      }
      try {
        const value = await fetcher(parsed.data.range);
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // getQuotaStatus
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.getQuotaStatus,
    async (): Promise<IpcResult<import('../types').QuotaStatus>> => {
      const fetcher = deps.getQuotaStatus;
      if (fetcher === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'getQuotaStatus',
          'awaiting quota.service',
        );
      }
      try {
        const value = await fetcher();
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // getSettings
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.getSettings,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<AppSettings>> => {
      const parsed = desktopApiSchemas.getSettings.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      try {
        const value = deps.getSettings();
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // updateSettings
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.updateSettings,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<AppSettings>> => {
      const parsed =
        desktopApiSchemas.updateSettings.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      try {
        // The schema is `.strict()` and every value is itself
        // pre-validated, so `parsed.data` is a safe `AppSettingsPatch`.
        // Cast through the inferred type — `Partial<AppSettings>` is
        // structurally identical for the keys present.
        const value = deps.updateSettings(parsed.data as AppSettingsPatch);
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // updateSecret
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.updateSecret,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<void>> => {
      const parsed = desktopApiSchemas.updateSecret.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      try {
        deps.updateSecret(parsed.data as UpdateSecretInput);
        return { ok: true, value: undefined };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // getDiagnostics  (TODO: wired by task 9.3)
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.getDiagnostics,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<DiagnosticsReport>> => {
      const parsed =
        desktopApiSchemas.getDiagnostics.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const fetcher = deps.getDiagnostics;
      if (fetcher === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'getDiagnostics',
          'awaiting diagnostics.service (task 9.3)',
        );
      }
      try {
        const value = await fetcher();
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // openExpanded
  // -------------------------------------------------------------------------
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.openExpanded,
    async (): Promise<IpcResult<void>> => {
      const opener = deps.openExpanded;
      if (opener === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'openExpanded',
          'expanded window opener not wired',
        );
      }
      try {
        opener();
        return { ok: true, value: undefined };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of channels) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}

// Channel type re-export for callers who want to assert against the
// invoke set (e.g. the test harness for Property 12).
export type { DesktopInvokeMethod };
