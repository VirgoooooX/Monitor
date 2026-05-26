// Shared main-process types. Source of truth for the renderer (which
// re-exports these via `import type` only — no runtime dependency).
//
// References: design.md §Data Models, §IPC Handler Registry,
// §`openclash.service.ts`, §Validation rules; PLAN.md §IPC Interface.

// ---------------------------------------------------------------------------
// Health priority ladder
// ---------------------------------------------------------------------------

export type HealthStatus =
  | 'home_down'
  | 'openclash_unreachable'
  | 'node_down'
  | 'partial_outage'
  | 'node_slow'
  | 'healthy';

/**
 * Result of a single TCP or HTTP probe.
 *
 * `latencyMs` is `null` whenever `ok === false`. Implementations MUST
 * leave `error` unset when `ok === true` (compatible with
 * `exactOptionalPropertyTypes`).
 */
export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

/**
 * Per-URL probe summary embedded in the dashboard payload.
 */
export interface ProbeResultDigest {
  url: string;
  ok: boolean;
  latencyMs: number | null;
}

/**
 * Pure inputs for `health.evaluate`. The function performs no I/O; the
 * caller assembles this view from the latest sample window in SQLite
 * plus an in-memory ring buffer.
 *
 * `consecutiveProbeFailures` is supplied by the caller (it is computed
 * over historical samples) so that the evaluator stays pure.
 */
export interface HealthInputs {
  /** Most-recent first; "consecutive 2 false" detects router_down. */
  routerReachableHistory: boolean[];
  openclashTcpReachable: boolean;
  /** `'auth_error'` is treated as "API alive" only by the controller, not by the evaluator. */
  openclashApiOk: boolean | 'auth_error';
  /** One entry per configured probe URL (only meaningful when API is OK). */
  currentNodeProbeResults: ProbeResult[];
  /** ms; the last N successful probes used for `node_slow` average. */
  recentSuccessProbeLatencies: number[];
  /** 0..1 over the last 5 attempts, or `null` when there is no history. */
  recentSuccessRate: number | null;
  /** Caller-supplied count of leading consecutive probe failures (>= 0). */
  consecutiveProbeFailures: number;
}

// ---------------------------------------------------------------------------
// OpenClash controller responses
// ---------------------------------------------------------------------------

/**
 * Permissive `/configs` shape. Only the fields we read are typed; the
 * Clash controller emits many more, all of which we tolerate.
 */
export interface ConfigsResponse {
  port?: number;
  'socks-port'?: number;
  'redir-port'?: number;
  'mixed-port'?: number;
  mode?: string;
  'log-level'?: string;
  'allow-lan'?: boolean;
  [key: string]: unknown;
}

export interface ProxyHistoryEntry {
  time: string;
  delay: number;
}

export interface ProxyEntry {
  type: string;
  name: string;
  /** Selector groups expose `now`; some implementations alias it as `current`. */
  now?: string;
  current?: string;
  all?: string[];
  history?: ProxyHistoryEntry[];
  udp?: boolean;
  [key: string]: unknown;
}

export interface ProxiesResponse {
  proxies: Record<string, ProxyEntry>;
}

export interface DelayResult {
  ok: boolean;
  delay: number | null;
  error?: string;
}

export interface TrafficSnapshot {
  up: number;
  down: number;
}

// ---------------------------------------------------------------------------
// Manual node switching
// ---------------------------------------------------------------------------

export type SwitchErrorCode =
  | 'http_error'
  | 'verify_mismatch'
  | 'verify_timeout'
  | 'auth_error';

export type SwitchNodeResult =
  | { ok: true; newCurrent: string; verifiedAt: number }
  | {
      ok: false;
      error: { code: SwitchErrorCode; message: string };
      actualCurrent: string | null;
    };

// ---------------------------------------------------------------------------
// Collector capability detection
// ---------------------------------------------------------------------------

export type CapabilityResult =
  | { status: 'ok' }
  | { status: 'degraded'; reason: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'disabled' };

// ---------------------------------------------------------------------------
// Dashboard / detail views
// ---------------------------------------------------------------------------

export interface DashboardState {
  status: HealthStatus;
  /** User-facing zh-CN label, see PLAN.md §UI 状态文字. */
  statusLabel: string;
  generatedAt: number;
  router: { ok: boolean; lastChange: number };
  openclash: {
    tcpOk: boolean;
    apiOk: boolean | 'auth_error';
    mode: string | null;
  };
  currentNode: {
    group: string | null;
    node: string | null;
    avgLatencyMs: number | null;
    probeResults: ProbeResultDigest[];
    successRate5: number | null;
    /** Last 60 latency points (ms). */
    sparkline: number[];
  };
  usageToday: { codex: number; gemini: number; opencode: number };
}

export interface NodeView {
  name: string;
  /** 机场分类 if known. */
  source: string | null;
  lastDelayMs: number | null;
  lastDelayAt: number | null;
  /** Rolling rate over the last 10 samples. */
  successRate: number | null;
}

export interface GroupView {
  name: string;
  type: string;
  current: string;
  nodes: NodeView[];
}

export interface OpenClashDetails {
  configs: ConfigsResponse | null;
  /** Primary group first. */
  groups: GroupView[];
  lastSnapshotAt: number | null;
  apiState: 'ok' | 'auth_error' | 'unreachable';
}

// ---------------------------------------------------------------------------
// AI usage aggregation
// ---------------------------------------------------------------------------

export type UsageRange = 'today' | 'week' | 'month';
export type CollectorStatus = 'ok' | 'degraded' | 'unavailable' | 'disabled';

export interface UsageProviderSummary {
  provider: string;
  status: CollectorStatus;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number | null;
  eventCount: number;
  /** Present iff `status !== 'ok'`. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Quota / Rate Limit tracking
// ---------------------------------------------------------------------------

/**
 * A single quota window (e.g. 5-hour or weekly) as reported by the
 * provider's API or embedded in local session logs.
 */
export interface QuotaWindow {
  /** Human-friendly window name: '5h', 'weekly', 'monthly', 'daily'. */
  name: string;
  /** Percentage of quota remaining (0–100). `null` if unknown. */
  percentLeft: number | null;
  /** Epoch ms when this window resets. `null` if unknown. */
  resetAt: number | null;
  /** Window length in seconds (e.g. 18000 for 5h, 604800 for weekly). */
  windowSeconds: number | null;
}

/**
 * Full quota snapshot for a single provider at a point in time.
 */
export interface QuotaSnapshot {
  provider: string;
  /** When this snapshot was captured (epoch ms). */
  capturedAt: number;
  /** Source of the snapshot: 'local_log' (parsed from session JSONL) or 'remote_api'. */
  source: 'local_log' | 'remote_api';
  /** One or more quota windows. */
  windows: QuotaWindow[];
}

/**
 * Combined quota status returned to the renderer.
 */
export interface QuotaStatus {
  /** Per-provider quota snapshots (latest known). */
  snapshots: QuotaSnapshot[];
}

export interface UsageSummary {
  range: UsageRange;
  perProvider: UsageProviderSummary[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface RouterHealthSettings {
  host: string;
  port: number;
}

export interface RefreshIntervalSettings {
  networkMs: number;
  openclashMs: number;
  currentNodeMs: number;
  nodeScanMs: number;
  usageMs: number;
  retentionMs: number;
}

export interface CollectorToggle {
  enabled: boolean;
}

export interface CliProxySettings {
  /** Enables the CLIProxyAPI compatibility collector. */
  enabled: boolean;
  /** Base URL for CLIProxyAPI management endpoints, e.g. http://127.0.0.1:8317. */
  managementUrl: string;
  /** Auth directory used by CLIProxyAPI; defaults to ~/.cli-proxy-api. */
  authDir: string;
  /** Max usage queue records to drain per tick. */
  usageQueueBatchSize: number;
}

/**
 * One entry in the user-curated list of switchable OpenClash config
 * files. The renderer displays `alias`; `path` is sent to the
 * management interface verbatim.
 *
 * See network-quick-actions/design.md §Settings Delta.
 */
export interface ManagementConfigFileEntry {
  /** Trimmed non-empty user-readable label. Renderer shows this; never the path. */
  alias: string;
  /**
   * Absolute path on the router; required to start with
   * `/etc/openclash/config/` and end with `.yaml` or `.yml` (validated
   * by zod in `schemas.ts`).
   */
  path: string;
}

/**
 * Settings for the OpenClash management interface (LuCI/ubus client
 * used to read & switch the active config file).
 *
 * See network-quick-actions/design.md §Settings Delta.
 */
export interface ManagementInterfaceSettings {
  /** Discriminator. v1 has a single value. */
  kind: 'openclash-luci';
  /** http(s)://host[:port] of the LuCI panel. No userinfo, no query, no fragment. */
  url: string;
  /** Per-request timeout in ms. Range 1000..30000, default 10000. */
  requestTimeoutMs: number;
  /** User-curated list of switchable config files. */
  configFileWhitelist: ManagementConfigFileEntry[];
}

/**
 * Persisted user settings. Secrets are NOT in this object; they live in
 * the `secrets` table and are accessed via the secrets module.
 */
export interface AppSettings {
  /** http(s) URL with non-empty host and port 1..65535. */
  controllerUrl: string;
  /** Ordered preference list; trimmed non-empty strings. */
  primaryGroups: string[];
  /** http(s) URLs; at least one entry. */
  probeUrls: string[];
  routerHealth: RouterHealthSettings;
  /** 0..10000 ms. */
  switchVerifyDelayMs: number;
  switchConfirmation: boolean;
  /** Each interval >= 1000 ms (prevents self-DOS). */
  refreshIntervals: RefreshIntervalSettings;
  collectors: Record<string, CollectorToggle>;
  /** CLIProxyAPI usage/auth compatibility settings. */
  cliproxy: CliProxySettings;
  /** Whether the app launches at OS login. Defaults to `false`. */
  autostart: boolean;
  /**
   * Per-config-switch verify window. Default 8000, range 1000..30000.
   * Must be >= 2 × switchVerifyDelayMs to avoid pathological scheduling.
   *
   * See network-quick-actions/design.md §Settings Delta.
   */
  configSwitchVerifyWindowMs: number;
  /**
   * OpenClash management interface (LuCI client) configuration.
   *
   * Note: there is intentionally NO `configSwitchConfirmation` field
   * (Requirement 6 + Requirement 13.2 invariant — config switches are
   * always confirmed by the renderer dialog, never gated by a setting).
   */
  managementInterface: ManagementInterfaceSettings;
}

// ---------------------------------------------------------------------------
// Diagnostics export
// ---------------------------------------------------------------------------

export interface CollectorHealthRow {
  collector: string;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
}

/**
 * Reduced projection of the most recent `openclash_config_changes`
 * `'end'` rows surfaced by `getDiagnostics`. Mirrors the shape called
 * out in network-quick-actions/design.md §Diagnostics — only the
 * fields needed for support-bundle triage are exposed; per-row
 * `startPath`, `finalPath`, and the `confirmed` invariant are omitted
 * to minimise the surface area.
 *
 * `resultCode` is the closed-set code from the management client (or
 * `'ok'` on success); see `ConfigChangeResultCode` in
 * `store/repositories.ts`. Re-stating the literal union here keeps the
 * renderer from needing to import the repository module.
 */
export interface RecentConfigSwitchEntry {
  targetPath: string;
  resultCode:
    | 'ok'
    | 'auth_error'
    | 'http_error'
    | 'network_error'
    | 'verify_timeout'
    | 'verify_mismatch'
    | 'not_supported';
  timestamp: number;
  /** `null` when the row's `duration_ms` was unset (defensive — `'end'` rows always populate it). */
  durationMs: number | null;
}

/**
 * Redacted summary of the live `managementInterface` settings included
 * in `getDiagnostics` for support-bundle triage. Sensitive material is
 * never surfaced:
 *   - `url` is run through `stripUrlCredentials` so any embedded
 *     username/password is erased (defense in depth — the validation
 *     schema already rejects URLs with userinfo).
 *   - `configFileWhitelist` is reduced to a count; individual
 *     entries' aliases / paths are intentionally elided so the report
 *     does not grow with the user's whitelist size.
 *
 * See network-quick-actions/design.md §Diagnostics, Requirement 12.4.
 */
export interface ManagementInterfaceDiagnosticsSummary {
  url: string;
  requestTimeoutMs: number;
  configFileWhitelistCount: number;
}

export interface DiagnosticsReport {
  generatedAt: number;
  collectors: CollectorHealthRow[];
  lastCapability: Record<string, CapabilityResult>;
  /** Controller URL with any embedded credential stripped. */
  redactedControllerUrl: string;
  /**
   * Last 10 `'end'` rows from `openclash_config_changes`, newest first
   * (network-quick-actions Requirement 8.4). Empty when the table has
   * no `'end'` rows yet.
   */
  recentConfigSwitches: RecentConfigSwitchEntry[];
  /**
   * Redacted summary of the live `managementInterface` settings
   * (network-quick-actions Requirement 12.4). The URL is stripped of
   * any embedded credentials and the whitelist is collapsed to a
   * count so individual entries never reach the diagnostics output.
   */
  managementInterface: ManagementInterfaceDiagnosticsSummary;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// IPC contract
// ---------------------------------------------------------------------------

export interface SwitchNodeInput {
  groupName: string;
  nodeName: string;
}

export interface UsageSummaryInput {
  range: UsageRange;
}

export type Unsubscribe = () => void;

export type DesktopPushChannel = 'dashboard.updated' | 'openclash.updated' | 'navigate-tab';

export interface DesktopPushPayloads {
  'dashboard.updated': DashboardState;
  'openclash.updated': OpenClashDetails;
  'navigate-tab': string;
}

export interface UpdateSecretInput {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Network Quick Actions (network-quick-actions feature)
// ---------------------------------------------------------------------------
//
// The runtime source of truth for these shapes is
// `networkQuickActionsSchema` / `configSwitchResultSchema` in
// `src/main/schemas.ts` (network-quick-actions task 10.2). The types
// below are **renderer-safe mirrors** kept in this module so the
// renderer can statically reason about `window.desktop.*` calls
// without breaching the sandbox boundary by importing from
// `src/main/services/**` or `src/main/ipc/**` (those modules carry
// runtime electron / better-sqlite3 dependencies that must never
// reach the renderer bundle).
//
// The literal-union mirror pattern follows
// `RecentConfigSwitchEntry.resultCode` above: a comment names the
// authoritative module and any drift will be caught at compile time
// because the IPC handler in `src/main/ipc/index.ts` constructs values
// of its own (structurally-identical) interface and the schema
// validators in `schemas.ts` enforce the wire shape.

/**
 * Closed enum of management-client error codes. Mirrors
 * `ManagementErrorCode` declared in
 * `src/main/services/openclash.management.service.ts`; see that
 * module's doc comment for the per-code semantics. Re-stated here so
 * the renderer never has to import from the services tree.
 */
export type ManagementErrorCode =
  | 'auth_error'
  | 'http_error'
  | 'network_error'
  | 'verify_timeout'
  | 'verify_mismatch'
  | 'not_supported';

/**
 * Single entry in the `Quick_Node_Card` candidate list. Mirrors
 * `QuickNodeCandidate` from
 * `src/main/services/quickNode.ranking.ts`. The ranking helper
 * guarantees `avgLatencyMs` is non-null for every survivor; the type
 * stays nullable here to match the design contract / schema.
 */
export interface QuickNodeCandidate {
  /** Node name as it appears in `/proxies`. */
  readonly nodeName: string;
  /** Mean of the success-only delay samples in the ranking window, or `null` when no successful samples exist. */
  readonly avgLatencyMs: number | null;
  /** Number of successful samples in the ranking window. */
  readonly okSamples: number;
  /** `true` iff the most recent sample succeeded. */
  readonly lastOk: boolean;
}

/**
 * Renderer-facing payload of `desktop:getNetworkQuickActions`. Mirrors
 * the `NetworkQuickActions` interface in `src/main/ipc/index.ts` and
 * the runtime `networkQuickActionsSchema` in `src/main/schemas.ts`.
 *
 * See `network-quick-actions/design.md §IPC Surface` for the
 * field-level contract.
 */
export interface NetworkQuickActions {
  primaryGroup: {
    name: string | null;
    currentNode: string | null;
    /** Length 0..5, ranked best-first. */
    candidates: QuickNodeCandidate[];
  };
  configFiles: {
    /** Active config (uci openclash.config.config_path) when management is reachable; `null` otherwise. */
    activePath: string | null;
    whitelist: Array<{
      alias: string;
      path: string;
      /** `true` iff `path === activePath`. */
      isActive: boolean;
    }>;
  };
  management: {
    /** URL non-empty AND both LuCI creds present in `secrets`. */
    configured: boolean;
    /** Most-recent management call succeeded. */
    reachable: boolean;
    /** Mirror of `collector_health.consecutive_failures` for `openclash.management`. */
    consecutiveFailures: number;
    /** Closed-enum failure code, or `null` when the last error string is a sentinel (e.g. `'credentials_cleared'`). */
    lastErrorCode: ManagementErrorCode | null;
  };
  lastConfigSwitch: {
    targetPath: string;
    resultCode: ManagementErrorCode | 'ok';
    timestamp: number;
  } | null;
  /**
   * Discriminator the UI gates button-disable logic on:
   *   - `false` — neither a config switch nor any node switch is mid-flight.
   *   - `{ kind: 'config' }` — a config switch holds the global lock.
   *   - `{ kind: 'node'; group }` — a node switch holds a group-scoped lock.
   */
  switchInProgress: false | { kind: 'config' } | { kind: 'node'; group: string };
}

/**
 * Result of `desktop:switchOpenClashConfig`. Mirrors `ConfigSwitchResult`
 * from `src/main/services/openclash.management.service.ts` and the
 * runtime `configSwitchResultSchema` in `src/main/schemas.ts`. The
 * orchestrator uses these fields verbatim when writing the `'end'`
 * audit row in `openclash_config_changes`.
 */
export interface ConfigSwitchResult {
  readonly ok: boolean;
  /** Active config the client read just before the write step. `null` if the read failed or was skipped. */
  readonly startPath: string | null;
  readonly targetPath: string;
  /** Active config observed by the verify loop. `null` when no read succeeded. */
  readonly finalPath: string | null;
  /** Present iff `ok === false`. */
  readonly error?: {
    readonly code: ManagementErrorCode;
    readonly message: string;
  };
}

/** Input payload for `desktop:switchOpenClashConfig`. */
export interface SwitchOpenClashConfigInput {
  /**
   * One of `settings.managementInterface.configFileWhitelist[*].path`.
   * Validated against the live whitelist by the main-side handler;
   * the schema only checks that the value is a non-empty trimmed
   * string.
   */
  targetPath: string;
}

/**
 * The single surface the renderer can call. Every method is wired
 * through preload via `contextBridge.exposeInMainWorld('desktop', api)`
 * and validated at the IPC boundary with the schemas in `schemas.ts`.
 */
export interface DesktopApi {
  getDashboard(): Promise<DashboardState>;
  getOpenClashDetails(): Promise<OpenClashDetails>;
  switchNode(input: SwitchNodeInput): Promise<SwitchNodeResult>;
  refreshNow(): Promise<void>;
  getUsageSummary(input: UsageSummaryInput): Promise<UsageSummary>;
  getQuotaStatus(): Promise<QuotaStatus>;
  getSettings(): Promise<AppSettings>;
  updateSettings(input: Partial<AppSettings>): Promise<AppSettings>;
  updateSecret(input: UpdateSecretInput): Promise<void>;
  getDiagnostics(): Promise<DiagnosticsReport>;
  openExpanded(): Promise<void>;
  // Network Quick Actions panel (network-quick-actions task 14.1).
  // Channel names are whitelisted in `src/main/ipc/channels.ts` and
  // every payload is validated by the zod schemas in
  // `src/main/schemas.ts` before reaching a service.
  getNetworkQuickActions(): Promise<NetworkQuickActions>;
  switchOpenClashConfig(
    input: SwitchOpenClashConfigInput,
  ): Promise<ConfigSwitchResult>;
  clearManagementCredentials(): Promise<void>;
  on<C extends DesktopPushChannel>(
    channel: C,
    cb: (payload: DesktopPushPayloads[C]) => void,
  ): Unsubscribe;
}

/**
 * Standard error envelope returned by IPC handlers when validation or
 * a service call fails. Handlers never throw across the IPC boundary.
 */
export interface IpcError {
  code: string;
  message: string;
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IpcError };
