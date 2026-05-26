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
  /** Whether the app launches at OS login. Defaults to `false`. */
  autostart: boolean;
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

export interface DiagnosticsReport {
  generatedAt: number;
  collectors: CollectorHealthRow[];
  lastCapability: Record<string, CapabilityResult>;
  /** Controller URL with any embedded credential stripped. */
  redactedControllerUrl: string;
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

export type DesktopPushChannel = 'dashboard.updated' | 'openclash.updated';

export interface DesktopPushPayloads {
  'dashboard.updated': DashboardState;
  'openclash.updated': OpenClashDetails;
}

export interface UpdateSecretInput {
  key: string;
  value: string;
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
  getSettings(): Promise<AppSettings>;
  updateSettings(input: Partial<AppSettings>): Promise<AppSettings>;
  updateSecret(input: UpdateSecretInput): Promise<void>;
  getDiagnostics(): Promise<DiagnosticsReport>;
  openExpanded(): Promise<void>;
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
