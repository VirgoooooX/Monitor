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
  EXCLUDED_NODE_NAMES,
  identifyPrimaryGroup,
  isPseudoNodeName,
  resolveSelectedNode,
  selectedNodeName,
} from '../services/openclash.groups';
import type { ConfigSwitchAuditService } from '../services/openclash.config.audit';
import type { DashboardService } from '../services/dashboard.service';
import type {
  ConfigSwitchResult,
  ManagementErrorCode,
  OpenClashManagementClient,
} from '../services/openclash.management.service';
import {
  rankQuickNodeCandidates,
  type QuickNodeCandidate,
  type QuickNodeSample,
} from '../services/quickNode.ranking';
import type { SwitchNodeService } from '../services/openclash.switch';
import type { SwitchLock } from '../services/switch.lock';
import type {
  ConfigChangeResultCode,
  NodeSampleRow,
  Repositories,
} from '../store/repositories';
import {
  ProviderAuthError,
  type ProviderAuthService,
  type ProviderAuthValidationResult,
} from '../services/provider_auth.service';
import type { QuotaService } from '../services/quota.service';
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
  ProviderAuthMetadata,
  ProxiesResponse,
  ProxyEntry,
  QuotaStatus,
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
 * Side-channel metadata kept by the orchestrator for every in-flight
 * `'config'` switch. Read by the lock's `onForceRelease` watchdog
 * callback (wired in `app.ts`) when the watchdog fires before the
 * orchestrator's normal `finally` path completes — at that point the
 * orchestrator no longer has the original `targetPath` / `startTs`
 * in scope, so the watchdog uses this map to write a
 * `verify_timeout` `'end'` audit row on the orchestrator's behalf
 * (Requirement 9.5 / design.md §Property 7).
 *
 * Keyed by {@link SwitchLockToken.id}. Insertions happen immediately
 * after the start audit row is written; deletions happen at the head
 * of the orchestrator's `finally` block (so the watchdog cannot race
 * with the normal end-row write — whichever side wins the deletion
 * is the one that writes the row).
 */
export interface InflightConfigSwitch {
  readonly targetPath: string;
  readonly startPath: string | null;
  readonly startTs: number;
  /** Repository row id of the `'start'` audit row, or `null` if the insert failed. */
  readonly auditRowId: number | null;
}

/**
 * Map keyed by switch-lock token id. Lives outside the IPC handler
 * (in `app.ts`) so the lock's `onForceRelease` callback can read
 * stranded entries without taking a circular reference on the
 * registry — see network-quick-actions task 10.4 implementation
 * notes.
 */
export type InflightConfigSwitchRegistry = Map<string, InflightConfigSwitch>;

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
  /**
   * OpenClash LuCI management client. Used by the
   * `clearManagementCredentials` handler (network-quick-actions task
   * 10.5) to invalidate any cached LuCI session cookie when the user
   * wipes the stored creds. Future tasks 10.3 / 10.4 will also reach
   * for `readActiveConfigPath()` and `switchActiveConfig()` here.
   */
  openClashManagementClient: OpenClashManagementClient;
  /**
   * Globally-exclusive switch mutex. The `switchOpenClashConfig`
   * handler (network-quick-actions task 10.4) takes a `'config'`
   * token before issuing any management-client call; on contention
   * it returns `{ ok: false, error: { code: 'switch_in_progress' } }`
   * (Requirement 9.2). The same instance is shared with
   * `health.service` so verify-window flap suppression
   * (Requirement 5.10) sees the same lock state.
   */
  switchLock: SwitchLock;
  /**
   * Audit-log writer for `openclash_config_changes`. The
   * `switchOpenClashConfig` handler writes a `'start'` row right
   * after the lock is acquired and an `'end'` row immediately before
   * the lock is released (Requirement 8.1, Property 6).
   */
  configSwitchAudit: ConfigSwitchAuditService;
  /**
   * Side-channel registry of in-flight `'config'` switches keyed by
   * lock-token id. Populated by the orchestrator just after the
   * `'start'` audit row lands; consumed by the lock's
   * `onForceRelease` callback (wired in `app.ts`) when the watchdog
   * fires before the orchestrator's `finally` path completes.
   * Without this map the watchdog has no way to recover the
   * `targetPath` / `startTs` it needs to write the `verify_timeout`
   * end row (Requirement 9.5).
   */
  inflightConfigSwitches: InflightConfigSwitchRegistry;
  /**
   * Live read of the canonical `AppSettings`.
   */
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
  /**
   * Delete a secret row from the encrypted store. The key is
   * validated against a known allowlist by the implementation
   * (network-quick-actions task 10.5 — only the two LuCI management
   * keys are deletable through this path; controller secrets must be
   * overwritten via `updateSecret` instead).
   */
  removeSecret: (key: string) => void;
  /**
   * Read a secret value from the encrypted store, or `null` when no
   * row exists (or the key is not in the allowlist on this build).
   * Used by the `getNetworkQuickActions` handler (task 10.3) to
   * answer "is the management interface configured?" — namely:
   * URL non-empty AND both the LuCI username + password are
   * present in `secrets`. The handler MUST NOT echo the returned
   * value across the IPC boundary; only its presence/absence is
   * surfaced as the boolean `management.configured`.
   */
  getSecret: (key: string) => string | null;
  /** Future service (task 7.8). When absent the IPC returns `not_implemented`. */
  getUsageSummary?: (range: UsageRange) => Promise<UsageSummary> | UsageSummary;
  /** Quota service. When absent the IPC returns `not_implemented`. */
  getQuotaStatus?: () => Promise<import('../types').QuotaStatus>;
  /**
   * Provider Auth service (cpa-quota-import task 10.3). Owns the
   * five `desktop:listProviderAuths` / `desktop:importProviderAuthFile` /
   * `desktop:deleteProviderAuth` / `desktop:validateProviderAuth` /
   * (delete + list + validate + import) handlers.
   *
   * Optional so the IPC registry can be constructed in unit tests
   * that do not exercise the Provider_Auth surface; when absent the
   * five matching handlers return `{ ok: false, error: { code:
   * 'not_implemented', ... } }`.
   */
  providerAuthService?: ProviderAuthService;
  /**
   * Quota service (cpa-quota-import task 10.3). Backs the
   * `desktop:refreshProviderQuota` handler. Distinct from
   * `getQuotaStatus` (which only exposes the cache-hot read path);
   * `quotaService.refresh()` is the per-account dispatch entry that
   * applies the 5-minute throttle and persists the post-refresh
   * cache.
   *
   * Optional for the same reason as `providerAuthService`.
   */
  quotaService?: QuotaService;
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

/**
 * Maximum length of an `IpcError.message` returned by the
 * Provider_Auth handlers. Mirrors the pre-redaction bound applied
 * inside `provider_auth.service` (`bound()` → 80 chars) and the
 * `z.string().max(80)` constraint on
 * `providerAuthMetadataSchema.lastErrorMessage`.
 */
const MAX_PROVIDER_AUTH_ERROR_MESSAGE_LEN = 80;

function boundProviderAuthMessage(message: string): string {
  return message.length <= MAX_PROVIDER_AUTH_ERROR_MESSAGE_LEN
    ? message
    : message.slice(0, MAX_PROVIDER_AUTH_ERROR_MESSAGE_LEN);
}

/**
 * Map a thrown error from the Provider_Auth pipeline onto the
 * renderer-facing `IpcResult` envelope.
 *
 * Mapping rules (cpa-quota-import design.md §IPC channels and
 * schemas + Requirements 1.1, 1.4, 9.1–9.6, 10.4):
 *
 *   - `ProviderAuthError`           → `{ code: err.code, message }`
 *     The closed `ProviderAuthErrorCode` union is preserved so the
 *     renderer can switch on the code without parsing the message.
 *   - `SecretsUnavailableError`     → `{ code: 'unavailable', message }`
 *     Surfaced when `safeStorage.isEncryptionAvailable() === false`;
 *     the renderer renders the "secret store unavailable" banner.
 *   - `SecretsDecryptError`         → `{ code: 'auth_expired', message }`
 *     Surfaced when DPAPI / kwallet rotated the master key under us;
 *     the user re-imports from CPA to recover.
 *   - Anything else                 → `INTERNAL_FAILURE(err)` (the
 *     generic `code: 'internal'` envelope with a non-secret message).
 *
 * The renderer-blind contract is enforced two ways:
 *   1. Messages are bounded to 80 chars (matching the
 *      `lastErrorMessage` storage budget) so a stray token fragment
 *      cannot escape via a long error message.
 *   2. The file path of the import dialog never appears here — the
 *      service-layer errors are pre-redacted and never carry the
 *      path in their `message` field (`provider_auth.service`
 *      docstring).
 */
function mapProviderAuthError(err: unknown): { ok: false; error: IpcError } {
  if (err instanceof ProviderAuthError) {
    return failure(err.code, boundProviderAuthMessage(err.message));
  }
  if (err instanceof Error) {
    if (err.name === 'SecretsUnavailableError') {
      return failure(
        'unavailable',
        boundProviderAuthMessage(
          err.message.length > 0
            ? err.message
            : 'secret storage unavailable',
        ),
      );
    }
    if (err.name === 'SecretsDecryptError') {
      // The `SecretsDecryptError` message includes the secret key
      // name (e.g. `cpaAuth.providerAuth.<uuid>`) which is non-
      // sensitive but also not useful to the renderer; we replace
      // it with a fixed bounded string to keep the envelope
      // deterministic and small.
      return failure(
        'auth_expired',
        boundProviderAuthMessage(
          'secret payload could not be decrypted',
        ),
      );
    }
  }
  return INTERNAL_FAILURE(err);
}

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
// Network Quick Actions composition (network-quick-actions task 10.3)
// ---------------------------------------------------------------------------
//
// References:
//   - .kiro/specs/network-quick-actions/design.md §IPC Surface (`NetworkQuickActions`)
//   - .kiro/specs/network-quick-actions/requirements.md §Requirement 2, 4, 14
//   - src/main/services/quickNode.ranking.ts (pure ranking helper)
//   - src/main/services/openclash.management.service.ts (`readActiveConfigPath`)
//
// Time-budget contract (Requirements 2.1, 2.2):
//   - When management is unreachable / unconfigured: <100 ms (we skip
//     every management-client call entirely; only the local SQLite
//     reads and the in-process Clash `getProxies` happen).
//   - When management is configured: <1500 ms — bounded by the management
//     client's `requestTimeoutMs` (default 10000, but overridden to a
//     short value here to keep the panel snappy).

/** Closed enum of `ManagementErrorCode` literals for runtime checks. */
const MANAGEMENT_ERROR_CODES: ReadonlySet<string> = new Set<ManagementErrorCode>([
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
  'not_supported',
]);

/**
 * Cap on the management `readActiveConfigPath` call inside
 * {@link buildNetworkQuickActions}. Independent of the user-tunable
 * `managementInterface.requestTimeoutMs` because Quick Actions must
 * stay snappy even when the user has dialled the global timeout up
 * for slow links.
 */
const QUICK_ACTIONS_MGMT_TIMEOUT_MS = 1500;

/**
 * Number of recent samples consumed by the ranking helper per
 * candidate node. Mirrors the `LATENCY_WINDOW = 10` constant in
 * `quickNode.ranking.ts`; if the helper relaxes its window the
 * over-read here is harmless because the helper trims internally.
 */
const QUICK_ACTIONS_LATENCY_WINDOW = 10;

/**
 * Coerce an arbitrary `last_error` string from `collector_health`
 * into the closed `ManagementErrorCode` set, returning `null` for
 * sentinel values like `'credentials_cleared'` or any future tag the
 * management client does not emit. The renderer's i18n map only
 * covers the closed set; surfacing anything else as `lastErrorCode`
 * would cause a missing-translation render.
 */
function coerceManagementErrorCode(
  lastError: string | null,
): ManagementErrorCode | null {
  if (lastError === null) return null;
  if (!MANAGEMENT_ERROR_CODES.has(lastError)) return null;
  return lastError as ManagementErrorCode;
}

/**
 * Translate the lock's snapshot into the `switchInProgress`
 * discriminator surfaced to the renderer. A held config token wins
 * over any node tokens (mirrors the lock's own acquisition rules:
 * config is globally exclusive); when only node tokens are held we
 * report the first one — there is at most one per group, but the
 * renderer treats `kind: 'node'` as "every node button is currently
 * disabled because we are mid-flight on group X" and the choice of
 * X is not material when multiple groups race.
 */
function deriveSwitchInProgress(
  lock: SwitchLock,
): { kind: 'config' } | { kind: 'node'; group: string } | false {
  const snapshot = lock.snapshot();
  if (snapshot.config !== null) {
    return { kind: 'config' };
  }
  const firstNode = snapshot.nodes[0];
  if (firstNode !== undefined && firstNode.kind.type === 'node') {
    return { kind: 'node', group: firstNode.kind.group };
  }
  return false;
}

/**
 * Build the `primaryGroup` slice of the payload. When the Clash
 * controller is unreachable (or the response carries no Selector
 * groups), `name` and `currentNode` collapse to `null` and
 * `candidates` is the empty array — the renderer renders the
 * "暂无可推荐节点" placeholder in that case.
 */
function buildPrimaryGroupSlice(
  proxies: ProxiesResponse | null,
  primaryGroups: readonly string[],
  repositories: Repositories,
): {
  name: string | null;
  currentNode: string | null;
  candidates: QuickNodeCandidate[];
} {
  if (proxies === null) {
    return { name: null, currentNode: null, candidates: [] };
  }

  const primary = identifyPrimaryGroup(proxies, primaryGroups);
  if (primary === null) {
    return { name: null, currentNode: null, candidates: [] };
  }

  // Resolve nested selectors (e.g. `🚀 节点选择 → 🇭🇰 香港 → CN HK01`)
  // so the candidate list reflects the leaf-bearing group the
  // `switchNode` IPC will write to. Falls back to the primary itself
  // when resolution fails.
  const resolved = resolveSelectedNode(proxies, primary);
  const groupName = resolved?.groupName ?? primary;
  const groupEntry = proxies.proxies[groupName];
  if (groupEntry === undefined) {
    return { name: groupName, currentNode: null, candidates: [] };
  }

  const currentNode = resolved?.nodeName ?? null;
  const allNames = groupEntry.all ?? [];
  const realCandidates = allNames.filter(
    (name) => !EXCLUDED_NODE_NAMES.has(name),
  );

  // Build the per-candidate sample histories. `recentForNode`
  // returns rows newest-first; the ranking helper expects oldest-
  // first arrays, so we reverse before handing off. Cap each per-
  // node history at `QUICK_ACTIONS_LATENCY_WINDOW` to keep the SQL
  // result tight.
  const recentSamples = new Map<string, QuickNodeSample[]>();
  for (const candidate of realCandidates) {
    const rows = repositories.nodeSamples.recentForNode(
      groupName,
      candidate,
      QUICK_ACTIONS_LATENCY_WINDOW,
    );
    if (rows.length === 0) {
      continue;
    }
    // Reverse newest-first → oldest-first so the ranking helper's
    // "last entry == most recent" contract is honoured.
    const samples: QuickNodeSample[] = rows
      .slice()
      .reverse()
      .map(
        (row: NodeSampleRow): QuickNodeSample => ({
          ok: row.ok,
          delayMs: row.delayMs,
        }),
      );
    recentSamples.set(candidate, samples);
  }

  const candidates = rankQuickNodeCandidates({
    candidates: realCandidates,
    recentSamples,
    currentNode,
  });

  return { name: groupName, currentNode, candidates };
}

/**
 * Build the `configFiles` slice of the payload. Reads the user-
 * curated whitelist from `AppSettings.managementInterface` and — when
 * management is configured — decorates each entry with `isActive`
 * based on the live `readActiveConfigPath()` probe. When management
 * is unreachable or unconfigured, `activePath` is `null` and every
 * `isActive` flag collapses to `false`.
 *
 * The probe is wrapped in a defensive try/catch even though the
 * management client's contract says it throws `ManagementError`
 * exclusively — the catch is cheap and absorbs any future drift.
 */
async function buildConfigFilesSlice(
  managementClient: OpenClashManagementClient,
  settings: AppSettings,
  managementConfigured: boolean,
): Promise<{
  activePath: string | null;
  whitelist: Array<{ alias: string; path: string; isActive: boolean }>;
}> {
  const whitelist = settings.managementInterface.configFileWhitelist;
  let activePath: string | null = null;

  if (managementConfigured) {
    try {
      activePath = await managementClient.readActiveConfigPath({
        timeoutMs: QUICK_ACTIONS_MGMT_TIMEOUT_MS,
      });
    } catch {
      // Any thrown error (ManagementError or otherwise) collapses to
      // "active path unknown". The collector_health row is updated
      // by the management client itself; we never echo error text
      // across the IPC boundary here.
      activePath = null;
    }
  }

  const decorated = whitelist.map((entry) => ({
    alias: entry.alias,
    path: entry.path,
    isActive: activePath !== null && entry.path === activePath,
  }));

  return { activePath, whitelist: decorated };
}

/**
 * Renderer-facing payload for the `desktop:getNetworkQuickActions`
 * IPC channel. The runtime source-of-truth is
 * `networkQuickActionsSchema` in `src/main/schemas.ts`
 * (network-quick-actions task 10.2); the local TypeScript shape
 * mirrors it for compile-time checking inside this module.
 *
 * Field semantics:
 *   - `primaryGroup`: identified group + ranked candidate buttons.
 *   - `configFiles`: user-curated whitelist decorated with `isActive`
 *     based on the live `readActiveConfigPath()` probe (skipped when
 *     management is unreachable / unconfigured).
 *   - `management`: live snapshot of `collector_health`'s
 *     `openclash.management` row; `configured` reflects the live
 *     creds + URL, `lastErrorCode` is restricted to the closed
 *     `ManagementErrorCode` set.
 *   - `lastConfigSwitch`: most recent `'end'` row from
 *     `openclash_config_changes` reduced to the renderer-relevant
 *     fields; `null` when no end row has been written yet.
 *   - `switchInProgress`: discriminator the UI gates button-disable
 *     logic on (`false` when neither a config nor any node switch
 *     is mid-flight).
 */
export interface NetworkQuickActions {
  primaryGroup: {
    name: string | null;
    currentNode: string | null;
    candidates: QuickNodeCandidate[];
  };
  configFiles: {
    activePath: string | null;
    whitelist: Array<{ alias: string; path: string; isActive: boolean }>;
  };
  management: {
    configured: boolean;
    reachable: boolean;
    consecutiveFailures: number;
    lastErrorCode: ManagementErrorCode | null;
  };
  lastConfigSwitch: {
    targetPath: string;
    resultCode: ConfigChangeResultCode;
    timestamp: number;
  } | null;
  switchInProgress:
    | false
    | { kind: 'config' }
    | { kind: 'node'; group: string };
}

/**
 * Compose the full {@link NetworkQuickActions} payload. Kept as a
 * non-method helper so the IPC handler stays focused on validation /
 * envelope wrapping while this body owns the data-orchestration
 * logic. The runtime contract is the `networkQuickActionsSchema` in
 * `src/main/schemas.ts` (network-quick-actions task 10.2); the
 * inline shape annotated here is identical and is repeated only so
 * TypeScript can typecheck the assembly without importing the schema.
 */
async function composeNetworkQuickActions(
  deps: IpcRegistryDeps,
): Promise<NetworkQuickActions> {
  const settings = deps.getSettings();

  // (1) Determine whether the management interface is configured at
  // all. Config = URL non-empty AND both LuCI creds present. Reading
  // the secrets here is cheap (one SQLite SELECT each) and never
  // echoes their values — only the boolean is surfaced.
  const url = settings.managementInterface.url.trim();
  const username = deps.getSecret('openclash.management.username');
  const password = deps.getSecret('openclash.management.password');
  const managementConfigured =
    url.length > 0 &&
    username !== null &&
    username.length > 0 &&
    password !== null &&
    password.length > 0;

  // (2) Read the management collector health row. A missing row is
  // equivalent to "never run" — we treat it as configured-but-not-
  // yet-reachable rather than unreachable so the renderer does not
  // immediately show the failure banner on a fresh launch.
  const healthRow = deps.repositories.collectorHealth.get(
    'openclash.management',
  );
  const consecutiveFailures = healthRow?.consecutiveFailures ?? 0;
  const lastErrorCode = coerceManagementErrorCode(
    healthRow?.lastError ?? null,
  );
  // `reachable` per design: most recent management call succeeded.
  // We approximate with "lastSuccessAt is set AND the failure streak
  // is zero". When `healthRow` is missing entirely (never called)
  // we report `reachable: false` so the panel renders cautiously.
  const reachable =
    healthRow !== undefined &&
    healthRow.lastSuccessAt !== null &&
    healthRow.consecutiveFailures === 0;

  // (3) Run the three independent reads in parallel. Each branch
  // is bounded:
  //   - `getProxies` is governed by the OpenClash client's own
  //     default timeout (5000 ms) — short enough to stay within the
  //     "<1500 ms when management reachable" budget when management
  //     is unconfigured (we don't even await it then). When the
  //     controller is genuinely down the call rejects fast via
  //     `NetworkError`.
  //   - `readActiveConfigPath` is capped at QUICK_ACTIONS_MGMT_TIMEOUT_MS
  //     by `buildConfigFilesSlice`.
  //   - The audit-log read is in-process SQLite (sub-ms).
  const proxiesPromise: Promise<ProxiesResponse | null> = deps.openClashClient
    .getProxies()
    .catch(() => null);
  const configFilesPromise = buildConfigFilesSlice(
    deps.openClashManagementClient,
    settings,
    managementConfigured,
  );
  const auditLatest = deps.repositories.openClashConfigChanges.latest();

  const [proxies, configFiles] = await Promise.all([
    proxiesPromise,
    configFilesPromise,
  ]);

  // (4) Build the primary-group slice from the proxies snapshot we
  // just fetched. When `proxies === null` (controller unreachable),
  // `buildPrimaryGroupSlice` returns the empty placeholder.
  const primaryGroup = buildPrimaryGroupSlice(
    proxies,
    settings.primaryGroups,
    deps.repositories,
  );

  // (5) Project the latest audit row into the renderer-facing
  // `lastConfigSwitch`. Only `'end'` rows carry a `result_code`; if
  // the most recent row is a `'start'` (i.e. a switch is mid-flight
  // and has not yet written its end row), we fall through to `null`
  // — `switchInProgress` already conveys that state.
  let lastConfigSwitch:
    | { targetPath: string; resultCode: ConfigChangeResultCode; timestamp: number }
    | null = null;
  if (
    auditLatest !== undefined &&
    auditLatest.status === 'end' &&
    auditLatest.resultCode !== null
  ) {
    lastConfigSwitch = {
      targetPath: auditLatest.targetPath,
      resultCode: auditLatest.resultCode,
      timestamp: auditLatest.timestamp,
    };
  }

  // (6) Translate the live lock state into the discriminator the
  // renderer's UI gates on (Requirement 5.3 / 9.2 / 9.3).
  const switchInProgress = deriveSwitchInProgress(deps.switchLock);

  return {
    primaryGroup,
    configFiles,
    management: {
      configured: managementConfigured,
      reachable,
      consecutiveFailures,
      lastErrorCode,
    },
    lastConfigSwitch,
    switchInProgress,
  };
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
  // getNetworkQuickActions  (network-quick-actions task 10.3)
  // -------------------------------------------------------------------------
  //
  // Builds the full payload for the expanded window's Quick Actions
  // panel. The handler stays thin — every piece of orchestration
  // logic lives in `composeNetworkQuickActions`, which is testable
  // without standing up Electron or the IPC handler registry.
  //
  // Time budget (Requirements 2.1, 2.2):
  //   - <100 ms when management is unreachable / unconfigured (the
  //     only network call is `getProxies`, and even that fails fast
  //     via `NetworkError` when the controller is genuinely down).
  //   - <1500 ms when management is configured (bounded by
  //     `QUICK_ACTIONS_MGMT_TIMEOUT_MS` plus the controller's own
  //     5000-ms default — but in practice the parallel branches
  //     short-circuit on the slowest single timer).
  //
  // Validates: Requirements 2.1, 2.2, 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 14.4
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.getNetworkQuickActions,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<NetworkQuickActions>> => {
      const parsed =
        desktopApiSchemas.getNetworkQuickActions.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      try {
        const value = await composeNetworkQuickActions(deps);
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // switchOpenClashConfig  (network-quick-actions task 10.4)
  // -------------------------------------------------------------------------
  //
  // Orchestrates a single OpenClash config-file switch end-to-end:
  //
  //   1. Live-whitelist the `targetPath` against
  //      `settings.managementInterface.configFileWhitelist`. The
  //      static schema (task 10.2) only validates the shape; the
  //      list mutates at runtime so the membership check has to
  //      happen here. Rejects with `code: 'validation'` if missing
  //      (Requirement 5.1).
  //   2. Acquire the `'config'` lock with a TTL of
  //      `2 × configSwitchVerifyWindowMs` so the watchdog only ever
  //      fires after the management client's verify loop has had a
  //      full window plus one full retry slot to land
  //      (Requirement 9.5). On contention return
  //      `code: 'switch_in_progress'` without doing anything else
  //      (Requirement 9.2 — the audit table stays untouched on
  //      rejection, which is what Property 6 enforces).
  //   3. Write the `'start'` audit row immediately after the lock
  //      acquires. The `startPath` is read from the management client
  //      best-effort — a failed pre-read is recorded as `null` and
  //      does NOT abort the flow (the management client itself does
  //      the same inside `switchActiveConfig`).
  //   4. Stash the in-flight metadata in `inflightConfigSwitches`
  //      keyed by token id so the lock's `onForceRelease` watchdog
  //      can recover it if the orchestrator panics or hangs past the
  //      TTL.
  //   5. Call `switchActiveConfig({ targetPath, verifyWindowMs,
  //      requestTimeoutMs })`. The management client owns the single-
  //      write + ≤3-verify-read contract (Requirements 5.4, 5.6, 5.8,
  //      5.9, 7.1, 7.2, 15.4, 15.5).
  //   6. Write the `'end'` audit row BEFORE releasing the lock — the
  //      audit-write-first ordering is what Property 6 codifies, and
  //      it lets future readers correlate a single switch's two rows
  //      against the `lockHeldFor` interval.
  //   7. Schedule a `'openclash.updated'` push (within 5 s) on
  //      success so the renderer can re-fetch the freshly active
  //      config (Requirement 6.4 / 7.5). The dashboard service's
  //      broadcast handles "no subscribers" by skipping the send;
  //      it never throws.
  //   8. The orchestrator never auto-retries the write step
  //      (Requirement 7.1) and never attempts a rollback to the
  //      previous config (Requirement 7.2).
  //
  // Validates: Requirements 5.1, 5.2, 5.5, 5.6, 5.7, 5.8, 5.9, 6.1,
  //            6.4, 7.1, 7.2, 7.5, 9.1, 9.2, 9.4, 9.5.
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.switchOpenClashConfig,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<ConfigSwitchResult>> => {
      // (1a) Static-shape validation. Malformed payloads bounce here
      // without ever calling into the management client / lock /
      // audit writer (network-quick-actions Property 17).
      const parsed =
        desktopApiSchemas.switchOpenClashConfig.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const { targetPath } = parsed.data;

      // (1b) Live-whitelist membership. The setting mutates at
      // runtime and is read here through the live `getSettings()`
      // accessor so a freshly-saved whitelist row takes effect on
      // the very next invocation.
      const settings = deps.getSettings();
      const whitelist =
        settings.managementInterface.configFileWhitelist;
      const inWhitelist = whitelist.some(
        (entry) => entry.path === targetPath,
      );
      if (!inWhitelist) {
        return failure(
          'validation',
          `targetPath '${targetPath}' is not in the configured whitelist`,
        );
      }

      // (2) Acquire the global `'config'` switch mutex. The TTL is
      // `2 × configSwitchVerifyWindowMs` per Requirement 9.5 — that
      // gives the management client one full verify window plus a
      // safety margin before the watchdog force-releases. A null
      // return signals that another switch (config OR any node
      // group) is already in flight.
      const verifyWindowMs = settings.configSwitchVerifyWindowMs;
      const requestTimeoutMs =
        settings.managementInterface.requestTimeoutMs;
      const lockTtlMs = 2 * verifyWindowMs;
      const token = deps.switchLock.acquire({ type: 'config' }, lockTtlMs);
      if (token === null) {
        // Property 6: no audit row is ever written for the
        // `switch_in_progress` branch (the closed enum
        // `ConfigChangeResultCode` does not even include this code).
        return failure(
          'switch_in_progress',
          'a switch is already in progress',
        );
      }

      // (3a) Pre-read the active config path so the audit row carries
      // it. A failed read records `null` and does NOT abort the flow
      // — the user's intent is to write, not to read, and the
      // management client's `switchActiveConfig` will independently
      // attempt this read for its own audit purposes.
      const startTs = Date.now();
      let startPath: string | null = null;
      try {
        startPath =
          await deps.openClashManagementClient.readActiveConfigPath({
            timeoutMs: requestTimeoutMs,
          });
      } catch {
        // Best-effort. Pre-read failure does not abort the switch.
      }

      // (3b) Insert the `'start'` audit row. The audit writer's
      // `recordSwitchStart` returns `null` if the underlying SQLite
      // insert throws — we still proceed with the switch because
      // audit must not gate the user-visible action.
      const auditRowId = deps.configSwitchAudit.recordSwitchStart({
        targetPath,
        startPath,
        now: startTs,
      });

      // (4) Stash the metadata so the lock's `onForceRelease`
      // watchdog can write a `verify_timeout` end row if the
      // orchestrator's `finally` path is preempted.
      deps.inflightConfigSwitches.set(token.id, {
        targetPath,
        startPath,
        startTs,
        auditRowId,
      });

      try {
        // (5) Issue the single write transaction + bounded verify
        // loop. The management client never throws — every failure
        // mode is encoded in the returned `ConfigSwitchResult`.
        const result =
          await deps.openClashManagementClient.switchActiveConfig({
            targetPath,
            verifyWindowMs,
            requestTimeoutMs,
          });

        // (6) Insert the `'end'` audit row BEFORE releasing the
        // lock. `resultCode` is the closed-enum mapping the
        // repository expects: `'ok'` on success, the management
        // client's own error code on failure, and a defensive
        // `'verify_timeout'` fallback in the (unreachable) case
        // where `result.ok === false` but `result.error` is missing.
        const endTs = Date.now();
        const resultCode: ConfigChangeResultCode = result.ok
          ? 'ok'
          : (result.error?.code ?? 'verify_timeout');
        deps.configSwitchAudit.recordSwitchEnd({
          rowId: auditRowId,
          targetPath,
          startPath,
          finalPath: result.finalPath,
          resultCode,
          startedAt: startTs,
          endedAt: endTs,
        });

        // (7) On success, schedule a dashboard rebroadcast so the
        // renderer's Quick Actions panel re-fetches the freshly
        // active config within 5 s (Requirement 6.4 / 7.5). The
        // delay is short — Requirement 7.5 caps at 5 s, and any
        // value below that is fine; we use 100 ms so the renderer
        // sees the new state on the very next paint frame. The
        // `setTimeout` is best-effort — `broadcastDashboard` skips
        // when there are no subscribers and never throws.
        if (result.ok) {
          const refreshHandle = setTimeout(() => {
            try {
              deps.dashboardService.broadcastDashboard();
            } catch {
              // Swallow — the audit row has already been written and
              // the IPC response is already returning success; a
              // failed rebroadcast is purely a UX nicety.
            }
          }, 100);
          // Don't keep the event loop alive solely for this scheduled
          // rebroadcast — if the process is shutting down the
          // refresh is irrelevant.
          const t = refreshHandle as { unref?: () => void };
          if (typeof t.unref === 'function') {
            t.unref();
          }
        }

        return { ok: true, value: result };
      } finally {
        // (8a) Drop the in-flight entry FIRST so the watchdog cannot
        // race with the normal-path end-row write. Whichever side
        // wins this `delete` is the side that wrote the row; the
        // other observes a missing key and exits.
        deps.inflightConfigSwitches.delete(token.id);
        // (8b) Release the lock last — at this point the audit row
        // is durable and the in-flight entry is gone, so a
        // concurrent acquire by the next caller cannot observe a
        // half-finished state.
        deps.switchLock.release(token);
      }
    },
  );

  // -------------------------------------------------------------------------
  // clearManagementCredentials  (network-quick-actions task 10.5)
  // -------------------------------------------------------------------------
  //
  // Wipes the two LuCI management credentials, invalidates any cached
  // session cookie inside the management client, and stamps the
  // `openclash.management` row of `collector_health` with the special
  // sentinel error string `'credentials_cleared'` so subsequent
  // diagnostics / Quick Actions reads can tell the difference between
  // "creds never configured" and "user explicitly cleared creds".
  //
  // The order matters:
  //
  //   1. Delete both `secrets` rows. If the second delete throws we
  //      still want the first to land — `removeSecret` is idempotent
  //      on the SQLite layer, so we don't try/catch around the pair.
  //   2. Tear down any cached cookie inside the management client so
  //      a subsequent privileged call cannot accidentally reuse a
  //      stale session that still authenticates with the just-cleared
  //      password (Requirement 12.5).
  //   3. Stamp `collector_health` so the IPC's
  //      `getNetworkQuickActions` payload (task 10.3) shows the
  //      sentinel reason. The repository's `recordFailure` writes
  //      `last_run_at`, `last_error`, `last_error_at`, and bumps
  //      `consecutive_failures` — the slight `consecutive_failures`
  //      bump is intentional per design.md: a cleared-cred state IS a
  //      failure mode and the badge should reflect it.
  //
  // Validates: Requirements 12.2, 12.5
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.clearManagementCredentials,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<void>> => {
      const parsed =
        desktopApiSchemas.clearManagementCredentials.input.safeParse(
          payload,
        );
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      try {
        // 1. Wipe both encrypted credential rows. The remove path is
        //    idempotent — calling it on a never-set key is a no-op.
        deps.removeSecret('openclash.management.username');
        deps.removeSecret('openclash.management.password');
        // 2. Drop any in-memory session cookie.
        deps.openClashManagementClient.invalidateSession();
        // 3. Mark the management row as "credentials cleared" so the
        //    Quick Actions panel can render the dedicated banner.
        deps.repositories.collectorHealth.recordFailure(
          'openclash.management',
          Date.now(),
          'credentials_cleared',
        );
        return { ok: true, value: undefined };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // listProviderAuths   (cpa-quota-import task 10.3)
  // -------------------------------------------------------------------------
  //
  // Returns every imported `provider_auth` row, projected through
  // `redactRow` so the response carries only `ProviderAuthMetadata`
  // fields — never a token / API key / file path / secretKey.
  //
  // No upstream calls; no secret decryption. The handler is the
  // hot-path read for the Provider_Auth section in `SettingsView`.
  //
  // Validates: Requirements 1.1, 1.4, 9.1, 9.6, 17.1
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.listProviderAuths,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<ProviderAuthMetadata[]>> => {
      const parsed =
        desktopApiSchemas.listProviderAuths.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const service = deps.providerAuthService;
      if (service === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'listProviderAuths',
          'awaiting provider_auth.service wiring',
        );
      }
      try {
        const value = service.list();
        return { ok: true, value };
      } catch (err) {
        return INTERNAL_FAILURE(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // importProviderAuthFile   (cpa-quota-import task 10.3)
  // -------------------------------------------------------------------------
  //
  // Drives the full CPA auth-file import pipeline. The renderer
  // sends only `{ provider }`; the service opens the OS file dialog
  // in main, reads + parses the file, writes the secret + row inside
  // a SQLite transaction, and runs the lightweight validate. The
  // response is the freshly-created `ProviderAuthMetadata` (redacted).
  //
  // Error mapping (see `mapProviderAuthError`):
  //   - `ProviderAuthError`         → `{ code: err.code, message }`
  //     covers `cancelled` / `unsupported_file` / `parse_error` /
  //     `auth_missing` and the future `project_missing` / etc.
  //   - `SecretsUnavailableError`   → `{ code: 'unavailable', ... }`
  //   - `SecretsDecryptError`       → `{ code: 'auth_expired', ... }`
  //   - everything else             → `INTERNAL_FAILURE`.
  //
  // The renderer-blind contract is preserved two ways:
  //   1. The response (success path) only carries `ProviderAuthMetadata`
  //      — the projection has no field for tokens / API keys.
  //   2. Errors carry only the bounded, pre-redacted message produced
  //      by the service layer; the file path the user picked never
  //      surfaces (Requirement 7.8 + design.md §Layered Trust Model).
  //
  // Validates: Requirements 1.1, 1.3, 1.4, 7.8, 8.1, 8.2, 8.5, 9.6
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<ProviderAuthMetadata>> => {
      const parsed =
        desktopApiSchemas.importProviderAuthFile.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const service = deps.providerAuthService;
      if (service === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'importProviderAuthFile',
          'awaiting provider_auth.service wiring',
        );
      }
      try {
        const value = await service.importFromFile(parsed.data);
        return { ok: true, value };
      } catch (err) {
        return mapProviderAuthError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // deleteProviderAuth   (cpa-quota-import task 10.3)
  // -------------------------------------------------------------------------
  //
  // Idempotent removal of a single `provider_auth` row + its
  // `secrets` payload, atomically inside a single SQLite
  // transaction (provided by the service). Removing an unknown id
  // is a no-op so a double-click on the renderer's Delete button
  // never produces an error envelope.
  //
  // Validates: Requirements 1.1, 1.4, 9.2, 9.6
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.deleteProviderAuth,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<void>> => {
      const parsed =
        desktopApiSchemas.deleteProviderAuth.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const service = deps.providerAuthService;
      if (service === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'deleteProviderAuth',
          'awaiting provider_auth.service wiring',
        );
      }
      try {
        service.remove(parsed.data.id);
        return { ok: true, value: undefined };
      } catch (err) {
        return mapProviderAuthError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // refreshProviderQuota   (cpa-quota-import task 10.3)
  // -------------------------------------------------------------------------
  //
  // Trigger a per-account quota refresh through the
  // {@link QuotaService}. The service applies the per-account
  // 5-minute throttle, dispatches every account through
  // `Promise.allSettled` so a single rejection cannot poison the
  // others, and returns the post-refresh `QuotaStatus` envelope.
  //
  // Adapter-level errors are absorbed inside `quotaService.refresh`
  // (the service translates them to a `stale` snapshot under the
  // existing `lastErrorCode` / `lastErrorMessage`); the only
  // exceptions that escape here are `SecretsUnavailableError` /
  // `SecretsDecryptError` (the service catches per-account secret
  // failures inside the dispatch loop, so this branch is reserved
  // for a global secret-store outage that aborts the whole refresh).
  //
  // Validates: Requirements 1.1, 1.4, 9.3, 9.4, 9.6, 11.1, 11.3
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.refreshProviderQuota,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<QuotaStatus>> => {
      const parsed =
        desktopApiSchemas.refreshProviderQuota.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const service = deps.quotaService;
      if (service === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'refreshProviderQuota',
          'awaiting quota.service wiring',
        );
      }
      try {
        // Reconstruct the input without explicit `undefined` values —
        // `exactOptionalPropertyTypes: true` rejects assigning
        // `string | undefined` into an optional `string` slot.
        const input: { id?: string; provider?: import('../types').ProviderId } = {};
        if (parsed.data.id !== undefined) input.id = parsed.data.id;
        if (parsed.data.provider !== undefined) input.provider = parsed.data.provider;
        const value = await service.refresh(input);
        return { ok: true, value };
      } catch (err) {
        return mapProviderAuthError(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // validateProviderAuth   (cpa-quota-import task 10.3)
  // -------------------------------------------------------------------------
  //
  // Lightweight validation of an already-imported account. Does NOT
  // call upstream — only inspects which fields the parser was able
  // to extract from the stored Secret Payload. The result envelope
  // (`{ ok, code, message }`) is the
  // `providerAuthValidationResultSchema` shape returned directly to
  // the renderer; "ok: false" outcomes are normal answers, not IPC
  // errors, so they ride inside the `IpcResult` success branch with
  // `code` widened to `'ok' | ProviderAuthErrorCode`.
  //
  // Validates: Requirements 1.4, 9.5, 9.6, 11.4
  ipcMain.handle(
    DESKTOP_INVOKE_CHANNELS.validateProviderAuth,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResult<ProviderAuthValidationResult>> => {
      const parsed =
        desktopApiSchemas.validateProviderAuth.input.safeParse(payload);
      if (!parsed.success) {
        return VALIDATION_FAILURE(parsed.error.issues);
      }
      const service = deps.providerAuthService;
      if (service === undefined) {
        return NOT_IMPLEMENTED_FAILURE(
          'validateProviderAuth',
          'awaiting provider_auth.service wiring',
        );
      }
      try {
        const value = service.validate(parsed.data.id);
        return { ok: true, value };
      } catch (err) {
        return mapProviderAuthError(err);
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
