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
  /** Data source identifier */
  source: 'events' | 'quotaDailyUsage' | 'none';
  /** Whether the provider has detailed token breakdown */
  hasTokenBreakdown: boolean;
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
 * Closed enumeration of where a `QuotaSnapshot` originated. Extended
 * by the cpa-quota-import feature (design.md §`QuotaSnapshot`
 * extension): the legacy `local_log` / `remote_api` values are kept
 * for the Codex JSONL fallback path and the v1.1 remote adapters,
 * while `imported_auth` / `health_check` are produced by the new
 * per-account adapters that consume a `Provider_Auth_Account`.
 */
export type QuotaSource =
  | 'local_log'
  | 'remote_api'
  | 'imported_auth'
  | 'health_check';

/**
 * Closed enumeration of what kind of measurement a snapshot carries.
 * `'quota'` and `'credits'` are reserved for `quota_capability =
 * 'official'` providers; `'health'` covers reachability-only checks;
 * `'usage'` is for providers whose only datum is local usage stats
 * (e.g. balances written by `usage.service.ts`). Defaults to
 * `'quota'` for the legacy Codex local-log path so existing
 * snapshots continue to validate.
 */
export type QuotaKind = 'quota' | 'credits' | 'health' | 'usage';

/**
 * Per-snapshot status discriminator. Distinct from the IPC envelope
 * `QuotaStatus` (which carries `snapshots: QuotaSnapshot[]`); the
 * `2` suffix avoids the name collision while leaving the public
 * envelope type stable.
 *
 *   - `ok`          — adapter returned a fresh result.
 *   - `stale`       — previous snapshot retained after a failed
 *                     refresh (Requirement 6.4).
 *   - `unavailable` — secret decryption failed or `safeStorage`
 *                     reported `isEncryptionAvailable === false`.
 *   - `unsupported` — Foundation Phase placeholder; the v1 adapter
 *                     for this provider returns no real data.
 *
 * Defaults to `'ok'` for legacy snapshots without an adapter result.
 */
export type QuotaStatus2 = 'ok' | 'stale' | 'unavailable' | 'unsupported';

/**
 * Full quota snapshot for a single provider at a point in time.
 *
 * Extended by the cpa-quota-import feature with per-account fields
 * (design.md §`QuotaSnapshot` extension). Existing fields keep their
 * shape; new fields are populated by the per-account adapters
 * introduced in v1, and default to `null` / `'quota'` / `'ok'` for
 * the legacy Codex local-log path so the snapshot type stays
 * structural.
 */
export interface QuotaSnapshot {
  // --- existing fields (kept verbatim) -------------------------------------
  provider: string;
  /** When this snapshot was captured (epoch ms). */
  capturedAt: number;
  /**
   * Source of the snapshot. The legacy `'local_log'` / `'remote_api'`
   * values remain in use for the Codex JSONL fallback and v1.1 remote
   * adapters; `'imported_auth'` and `'health_check'` are produced by
   * the per-account adapters introduced in cpa-quota-import.
   */
  source: QuotaSource;
  /** One or more quota windows. */
  windows: QuotaWindow[];

  // --- cpa-quota-import additions ------------------------------------------
  /**
   * `provider_auth.id` of the account this snapshot was produced for.
   * `null` only for the legacy Codex local-log fallback path
   * (Requirement 11.6) — every snapshot produced by a per-account
   * adapter carries a non-null id.
   */
  providerAuthId: string | null;
  /** Mirror of `provider_auth.label`; `null` for the legacy path. */
  accountLabel: string | null;
  /** ChatGPT / Codex account id when known; `null` otherwise. */
  accountId: string | null;
  /** Google project id (Gemini CLI / Antigravity) when known. */
  projectId: string | null;
  /** Defaults to `'quota'` for legacy rows. */
  kind: QuotaKind;
  /** Defaults to `'ok'` for legacy rows. */
  status: QuotaStatus2;
  /** Pre-redacted plan label / tier; `null` when not surfaced by the adapter. */
  rawPlanLabel: string | null;
  /** Model grouping (e.g. Claude Sonnet / Opus, Gemini Flash / Pro). */
  modelGroup: string | null;
  /** Closed-set error code from the latest adapter result, or `null`. */
  lastErrorCode: ProviderAuthErrorCode | null;
  /** ≤80 chars, pre-redacted; `null` iff there is no error. */
  lastErrorMessage: string | null;
  /**
   * Optional daily-usage history surfaced by per-account adapters
   * that have access to it (currently Xiaomi MiMo). Each entry is one
   * day of aggregate spend / consumption; renderers turn this into
   * the inline sparkline that sits next to the credits amount.
   *
   * `null` / undefined means the adapter did not collect this data
   * (most adapters don't); an empty array means it tried but the
   * range was empty. Decimal strings are preserved verbatim to avoid
   * float drift on monetary values, mirroring the credits-window
   * convention.
   */
  dailyUsage?: ReadonlyArray<DailyUsagePoint> | null;
}

/**
 * One day of aggregated AI usage. Produced by adapters that expose
 * a per-day usage endpoint (Xiaomi MiMo `/api/v1/usage/detail/list`)
 * and consumed by the QuotaStrip sparkline.
 */
export interface DailyUsagePoint {
  /** ISO date string `YYYY-MM-DD`. */
  readonly date: string;
  /** Total cost spent that day, decimal string preserving precision. */
  readonly cost: string;
  /** Total tokens consumed that day. */
  readonly totalTokens: number;
}

/**
 * Combined quota status returned to the renderer.
 */
export interface QuotaStatus {
  /** Per-provider quota snapshots (latest known). */
  snapshots: QuotaSnapshot[];
}

// ---------------------------------------------------------------------------
// CPA Quota Import / Provider Auth (Foundation Phase)
// ---------------------------------------------------------------------------
//
// Source of truth for the closed `ProviderId` enum and its default
// `QuotaCapability` mapping. Subsequent tasks in this feature
// (cpa-quota-import) extend this section with `ProviderAuthMetadata`,
// `ProviderAuthSecretPayload`, `ProviderAuthErrorCode`, and the
// `QuotaSnapshot` per-account fields.
//
// References: cpa-quota-import/requirements.md Requirement 4.1, 4.3,
// 5.1, 5.2; cpa-quota-import/design.md §Components and Interfaces >
// `ProviderId` and `Quota_Capability`.

/**
 * Closed enumeration of provider identifiers supported by the
 * Provider_Auth import flow and the multi-provider quota aggregator.
 *
 * v1 takes the 8 values pinned in `requirements.md` Requirement 4.1.
 * Adding a new provider requires a follow-up spec + migration; the
 * union is deliberately closed so `zod` schemas, the import dialog
 * picker, and the adapter registry can all rely on exhaustive
 * matching.
 */
export type ProviderId =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'antigravity'
  | 'kiro-ide'
  | 'gemini-api'
  | 'deepseek'
  | 'xiaomi'
  | 'opencode'
  | 'openai-compatible';

/**
 * Closed enumeration of how much quota visibility a given provider
 * exposes:
 *
 *   - `official`     — first-party quota / credits endpoint exists; the
 *                      aggregator may produce `kind ∈ { 'quota', 'credits' }`
 *                      snapshots.
 *   - `health_only`  — only a reachability / auth check is available;
 *                      the aggregator emits `kind: 'health'` snapshots.
 *   - `usage_only`   — no remote quota; UI surfaces local usage stats
 *                      (e.g. token / balance counters from `usage_events`).
 *   - `unsupported`  — placeholder for provider rows that should not be
 *                      polled (future use).
 */
export type QuotaCapability =
  | 'official'
  | 'health_only'
  | 'usage_only'
  | 'unsupported';

/**
 * Default `QuotaCapability` for each `ProviderId`. Consulted **once**
 * at import time to seed `provider_auth.quota_capability`; existing
 * rows are never auto-rewritten when this map evolves.
 *
 * DeepSeek resolves to `official` because the first-party
 * `/user/balance` endpoint returns account credits.
 *
 * Xiaomi resolves to `official` because the platform exposes
 * `/api/v1/balance` returning recharge credits in CNY/USD; the
 * adapter trades the long-lived `passToken` for a short-lived
 * `serviceToken` on demand.
 *
 * OpenCode Go resolves to `official` because the platform's Go
 * dashboard SSR-renders rolling/weekly/monthly usage percentages
 * directly into the HTML; the adapter scrapes those values via
 * the user-supplied `auth` cookie.
 */
export const PROVIDER_DEFAULT_CAPABILITY: Record<ProviderId, QuotaCapability> = {
  'claude-code': 'official',
  codex: 'official',
  'gemini-cli': 'official',
  antigravity: 'official',
  'kiro-ide': 'official',
  'gemini-api': 'health_only',
  deepseek: 'official',
  xiaomi: 'official',
  opencode: 'official',
  'openai-compatible': 'health_only',
};

/**
 * Closed enumeration of error codes surfaced by the Provider_Auth
 * import / validation / refresh pipelines and the per-account quota
 * adapters. Pinned by `cpa-quota-import/requirements.md` Requirement
 * 10.1; the order below matches that listing.
 *
 * Each code carries a fixed UI semantic:
 *
 *   - `auth_missing`         — secret allowlist hit but no payload found.
 *   - `auth_expired`         — token expired / DPAPI decrypt failure;
 *                              user must re-import from CPA.
 *   - `project_missing`      — Gemini CLI / Antigravity payload lacks
 *                              the required `project_id`.
 *   - `upstream_unauthorized`— provider returned 401/403; v1.1 only.
 *   - `rate_limited`         — provider returned 429.
 *   - `upstream_changed`     — provider response shape diverged from
 *                              the contract; v1.1 only.
 *   - `network_error`        — DNS / TCP / TLS failure.
 *   - `unsupported`          — Foundation Phase placeholder adapter
 *                              return value; replaced by real codes
 *                              in v1.1.
 *   - `parse_error`          — CPA auth file is malformed or oversized.
 *   - `unsupported_file`     — picked file is not `.json` / `.txt`.
 *   - `cancelled`            — user dismissed the OS file dialog.
 *   - `validation`           — IPC schema rejected the request payload.
 */
export type ProviderAuthErrorCode =
  | 'auth_missing'
  | 'auth_expired'
  | 'project_missing'
  | 'upstream_unauthorized'
  | 'rate_limited'
  | 'upstream_changed'
  | 'network_error'
  | 'unsupported'
  | 'parse_error'
  | 'unsupported_file'
  | 'cancelled'
  | 'validation';

/**
 * Renderer-visible projection of one `provider_auth` row.
 *
 * This is the **only** shape the IPC layer is allowed to hand back to
 * the renderer for an imported account: it carries no access token,
 * no refresh token, no API key, no expiry, no `baseUrl`, and no
 * filesystem path. The redaction is structural — there is literally
 * nowhere on this type for a secret to live — which makes the
 * Provider_Auth IPC channels renderer-blind by construction
 * (`requirements.md` Requirement 1.4 + design.md §Layered Trust
 * Model).
 *
 * `lastErrorMessage` is bounded at 80 characters by the IPC schema
 * (`schemas.ts`); messages are pre-redacted by `provider_auth.service`
 * before the row is returned.
 */
export interface ProviderAuthMetadata {
  /** Local UUIDv4. Stable across renames; never reused after delete. */
  id: string;
  provider: ProviderId;
  /**
   * User-readable label. Falls back to a derived value
   * (`accountId` → `email` → `<provider>:imported-<short-uuid>`)
   * when the source CPA file does not carry an explicit `label`.
   */
  label: string;
  /**
   * Where the row originated.
   *
   *   - `'cpa-auth-file'`   — imported from a CPA / CLIProxyAPI auth file
   *                           via the OS file dialog.
   *   - `'manual-api-key'`  — typed in by the user on the AI accounts
   *                           settings panel; only API-key providers
   *                           (`gemini-api`, `deepseek`, `xiaomi`,
   *                           `openai-compatible`) take this path.
   */
  source: 'cpa-auth-file' | 'manual-api-key';
  /** ChatGPT / Codex account id when the parser could extract one. */
  accountId: string | null;
  /** Google project id (Gemini CLI / Antigravity) when known. */
  projectId: string | null;
  quotaCapability: QuotaCapability;
  /** Epoch ms; row creation. */
  importedAt: number;
  /** Epoch ms; latest mutation (validate / refresh / metadata edit). */
  updatedAt: number;
  /** Epoch ms of the last lightweight validate, or `null` if never run. */
  lastValidatedAt: number | null;
  /** Epoch ms of the last successful adapter refresh, or `null`. */
  lastQuotaAt: number | null;
  lastErrorCode: ProviderAuthErrorCode | null;
  /** ≤80 chars, pre-redacted. `null` iff there is no error. */
  lastErrorMessage: string | null;
  /**
   * `true` while the account participates in quota / usage refresh.
   * `false` keeps the row visible in Settings but excludes it from
   * scheduled refreshes, the quota cache, and the usage summary —
   * the user can re-enable it without re-importing.
   *
   * New rows default to `true`; pre-existing rows from before the
   * field landed migrate to `true` via the SQLite default.
   */
  enabled: boolean;
}

/**
 * Subset of API-key providers that accept a manually-typed credential
 * via the "AI 账号" settings panel. OAuth-style providers
 * (`claude-code`, `codex`, `gemini-cli`, `antigravity`) are NOT in
 * this set — they require the full CPA auth-file import flow because
 * the access token must be paired with a refresh token / project id
 * the user cannot reasonably copy-paste.
 */
export type ManualApiKeyProvider =
  | 'gemini-api'
  | 'deepseek'
  | 'xiaomi'
  | 'opencode'
  | 'openai-compatible';

/**
 * Renderer-supplied input for `desktop:createProviderAuthApiKey`.
 *
 * The renderer cannot ship a plain Secret_Payload across the IPC
 * boundary because the contract is renderer-blind by construction
 * (Requirement 1.4). This shape is the manual entry point: it
 * carries only the small set of fields the user typed into the form,
 * and the service shapes them into the canonical
 * {@link ProviderAuthSecretPayload} before encrypting.
 *
 * `baseUrl` is required for `'openai-compatible'` and optional for
 * the other API-key providers.
 */
export interface CreateProviderAuthApiKeyInput {
  provider: ManualApiKeyProvider;
  /** Optional user-readable label. The service generates a sensible default when blank. */
  label?: string;
  /**
   * Required for every provider EXCEPT `xiaomi`. Encrypted at rest
   * under `cpaAuth.providerAuth.<id>`. Xiaomi accounts use
   * `xiaomiPassToken` + `xiaomiUserId` instead.
   */
  apiKey?: string;
  /** Required for `'openai-compatible'`; optional otherwise. */
  baseUrl?: string;
  /**
   * Xiaomi MiMo only — `passToken` cookie copied from
   * `account.xiaomi.com`. Required when `provider === 'xiaomi'`.
   */
  xiaomiPassToken?: string;
  /**
   * Xiaomi MiMo only — `userId` cookie copied from
   * `account.xiaomi.com`. Required when `provider === 'xiaomi'`.
   */
  xiaomiUserId?: string;
  /**
   * DeepSeek only — `userToken` value from
   * `platform.deepseek.com` localStorage. Optional even for
   * DeepSeek (the API key alone covers the basic balance read);
   * when present the adapter unlocks multi-wallet detail and the
   * daily-usage sparkline.
   */
  deepseekUserToken?: string;
  /**
   * OpenCode Go only — opaque `auth` cookie value from
   * `https://opencode.ai`. Required when `provider === 'opencode'`.
   */
  opencodeAuthCookie?: string;
  /**
   * OpenCode Go only — workspace dashboard URL or path
   * (`https://opencode.ai/workspace/wrk_.../go` or just
   * `/workspace/wrk_.../go`). Required when `provider === 'opencode'`.
   */
  opencodeWorkspaceUrl?: string;
}

/**
 * Renderer-supplied input for `desktop:setProviderAuthEnabled`. The
 * handler is idempotent on a missing id (returns `null`).
 */
export interface SetProviderAuthEnabledInput {
  id: string;
  enabled: boolean;
}

/**
 * Main-only structural type carrying the encrypted-at-rest secret
 * material for one Provider_Auth row. NEVER re-exported from the
 * renderer mirror (`src/renderer/lib/types.ts`) — referencing it from
 * the renderer bundle is a compile-time error, which keeps token /
 * API key fields off the IPC surface by construction.
 *
 * The full payload is JSON-serialized and stored as a single
 * ciphertext blob in the `secrets` table under the key
 * `cpaAuth.providerAuth.<id>` (design.md §Storage Layout). Decryption
 * is amortised — one `safeStorage.decryptString` per refresh.
 *
 * Every field is optional so a single shape covers OAuth providers
 * (`accessToken` + `refreshToken` + `expiresAt`) and plain API-key
 * providers (`apiKey`) without per-provider sub-types.
 */
export interface ProviderAuthSecretPayload {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  accountId?: string;
  projectId?: string;
  /** Epoch ms; absent for plain API-key payloads. */
  expiresAt?: number;
  baseUrl?: string;
  /**
   * Xiaomi MiMo only — long-lived `passToken` cookie copied from
   * `account.xiaomi.com`. Combined with `xiaomiUserId` to derive
   * the short-lived `serviceToken` on demand. NEVER logged.
   */
  xiaomiPassToken?: string;
  /**
   * Xiaomi MiMo only — numeric `userId` cookie from
   * `account.xiaomi.com`. Stored alongside `xiaomiPassToken`.
   */
  xiaomiUserId?: string;
  /**
   * DeepSeek only — long-lived `userToken` lifted from the console's
   * `localStorage`. When present, the adapter prefers the console
   * endpoints (`/api/v0/users/get_user_summary`,
   * `/api/v0/usage/cost`) over `api.deepseek.com/user/balance`,
   * which gives us multi-wallet balance breakdown and per-day
   * usage history. Falls back to `apiKey` when absent. NEVER logged.
   */
  deepseekUserToken?: string;
  /**
   * OpenCode Go (anomaly.co) only — opaque `auth` cookie value
   * (Iron-format session, prefix `Fe26.2`) lifted from
   * `https://opencode.ai`. The adapter cannot decrypt it; it
   * forwards verbatim as `Cookie: auth=<...>` to the workspace
   * dashboard URL and parses the SSR-rendered HTML for usage
   * percentages. NEVER logged.
   */
  opencodeAuthCookie?: string;
  /**
   * OpenCode Go only — workspace dashboard path (e.g.
   * `/workspace/wrk_01KR2KPDGZ7HTGZCPQQWC82MS4/go`). Required
   * because each user has a workspace-specific URL; we accept
   * either the full HTTPS URL or just the path and normalise.
   */
  opencodeWorkspaceUrl?: string;
  /**
   * Kiro IDE only — AWS CodeWhisperer profile ARN
   * (`arn:aws:codewhisperer:<region>:<account>:profile/<id>`)
   * that the IDE drops into `~/.aws/sso/cache/kiro-auth-token.json`
   * on every login. The fourth ARN segment encodes the Q Developer
   * region the adapter must hit (`https://q.<region>.amazonaws.com/getUsageLimits`),
   * so we surface it as a first-class secret-payload field instead
   * of stashing it in `accountId`. NEVER logged.
   */
  kiroProfileArn?: string;
  /**
   * Kiro IDE only — `authMethod` field copied verbatim from
   * `~/.aws/sso/cache/kiro-auth-token.json`. Drives which OAuth
   * refresh endpoint we hit:
   *   - `'social'` (Google / GitHub / Microsoft) → POST
   *     `https://prod.<region>.auth.desktop.kiro.dev/refreshToken`
   *   - `'sso'` / `'idc'` (AWS IAM Identity Center) → POST
   *     `https://oidc.<region>.amazonaws.com/token`
   * v1 only auto-refreshes the `social` path; SSO falls back to the
   * existing "凭据已过期" prompt.
   */
  kiroAuthMethod?: string;
  /**
   * Kiro IDE only — absolute path to the `kiro-auth-token.json`
   * file that auto-discovery imported this row from. Stored so the
   * adapter can (a) re-read the file before refreshing to detect
   * IDE-side races, and (b) write the rotated token back so the
   * IDE keeps working too. NEVER logged.
   */
  kiroSourceFilePath?: string;
  /** Verbatim `metadata.*` block from the CPA file (minus secret keys). */
  rawMetadata?: Record<string, unknown>;
  /** Verbatim `attributes.*` block from the CPA file (minus secret keys). */
  rawAttributes?: Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// Appearance / theming
// ---------------------------------------------------------------------------

/**
 * Color scheme applied to the expanded window. The compact widget
 * does NOT honour `colorMode` because it is fully transparent and
 * each `compactTheme` carries its own surface treatment; running it
 * through a `light` recolouring would defeat the high-contrast
 * intent of the floating overlay.
 */
export type ColorMode = 'dark' | 'light';

/**
 * Hand-tuned visual presets for the compact (floating) widget.
 *
 * Six new design-language presets (from theme system v2) plus five
 * legacy presets retained as additional options for users who
 * preferred the v1 looks. The underlying data slots (network
 * status + sparkline up top, AI quota + token summary below) are
 * identical across every preset so users can swap themes without
 * re-learning where information lives.
 *
 * v2 design-language presets:
 *   - liquid-glass    : light translucent iOS-style glass widget.
 *   - material-you    : light Material You / MD3 tonal surfaces.
 *   - soft-neumorph   : light soft neumorphic, embossed + inset.
 *   - paper-dashboard : light paper / Notion-style ledger.
 *   - mint-monitor    : dark mint-green monitoring card (default
 *                       reference design — semi-transparent surface
 *                       with status pill and sparkline mini-window).
 *   - device-oled     : dark hardware OLED dashboard with metal bezel.
 *
 * v1 legacy presets:
 *   - obsidian-glass  : calm dark glass with a cool rim.
 *   - aurora-ring     : slow conic-gradient aurora hugging the edge.
 *   - holo-grid       : HUD-style grid + scanning line.
 *   - liquid-metal    : graphite + slow specular sweep.
 *   - signal-pulse    : status-driven concentric pulse.
 */
export type CompactTheme =
  | 'liquid-glass'
  | 'material-you'
  | 'soft-neumorph'
  | 'paper-dashboard'
  | 'mint-monitor'
  | 'device-oled'
  | 'obsidian-glass'
  | 'aurora-ring'
  | 'holo-grid'
  | 'liquid-metal'
  | 'signal-pulse';

/**
 * Persisted appearance preferences. Both fields are required; a
 * normalize step in `app.ts` fills in the defaults for users whose
 * settings predate this feature.
 */
export interface AppearanceSettings {
  colorMode: ColorMode;
  compactTheme: CompactTheme;
  /**
   * Global UI typography scale for the expanded window. `1` is the
   * designed baseline; users can tune this in Settings when a monitor
   * or Windows scaling makes small text feel cramped.
   */
  fontScale: number;
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
  /**
   * Visual appearance: expanded-window color scheme + compact-window
   * theme preset. Required at runtime; the boot sequence normalizes
   * older settings rows that predate this field.
   */
  appearance: AppearanceSettings;
  /**
   * Kiro IDE token auto-refresh policy. When `enabled` is true and
   * the access token in `~/.aws/sso/cache/kiro-auth-token.json` is
   * within `KIRO_REFRESH_THRESHOLD_MS` of expiring, the adapter
   * exchanges the refresh token for a fresh access token before
   * each `getUsageLimits` call. When `writeBackAuthFile` is also
   * true, the rotated tokens are persisted back to the source JSON
   * so the Kiro desktop IDE picks up the new refresh-token chain
   * on its next read.
   *
   * The boot sequence normalizes older settings rows that predate
   * this block to `{ enabled: true, writeBackAuthFile: true }`.
   */
  kiroTokenRefresh: KiroTokenRefreshSettings;
}

/**
 * Per-`kiro-ide` row auto-refresh policy. See
 * {@link AppSettings.kiroTokenRefresh} for the semantics.
 */
export interface KiroTokenRefreshSettings {
  /** When false, the adapter behaves as it did pre-feature: refuse on expired access token. */
  enabled: boolean;
  /**
   * When true, every successful refresh atomically rewrites
   * `~/.aws/sso/cache/kiro-auth-token.json` with the rotated tokens
   * so the Kiro IDE can keep using the same refresh-token chain.
   * When false, only the in-process `secrets` row is updated — the
   * IDE will fall back to its own refresh on next read.
   */
  writeBackAuthFile: boolean;
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
 * Per-`provider_auth`-row projection embedded in the diagnostics
 * export (Requirement 13.4). Exposes only the non-sensitive
 * troubleshooting fields — by Q5 resolution, the redacted shape
 * deliberately excludes `label`, `accountId`, and `projectId`
 * (semi-sensitive: an account label can carry a personal email or
 * the literal Google project id, both of which are unnecessary for
 * support-bundle triage). The producing projection lives in
 * `services/provider_auth.service.ts#diagnosticsRow` and is the
 * single source of truth for the column whitelist.
 */
export interface ProviderAuthDiagnosticsEntry {
  id: string;
  provider: ProviderId;
  quotaCapability: QuotaCapability;
  lastErrorCode: ProviderAuthErrorCode | null;
  lastQuotaAt: number | null;
  lastValidatedAt: number | null;
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
  /**
   * Redacted projection of every `provider_auth` row
   * (cpa-quota-import Requirement 13.4). Only the troubleshooting
   * fields are surfaced — `label`, `accountId`, and `projectId` are
   * deliberately omitted per the Q5 resolution. Empty when no
   * accounts have been imported.
   */
  providerAuthAccounts: ProviderAuthDiagnosticsEntry[];
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

export type DesktopPushChannel =
  | 'dashboard.updated'
  | 'openclash.updated'
  | 'navigate-tab'
  | 'settings.updated'
  | 'provider-auth.updated';

/**
 * Payload pushed on the `provider-auth.updated` channel after any
 * change to the `provider_auth` table (create / delete / import /
 * setEnabled / quota refresh) so renderers that mirror the list or
 * the quota strip can react without waiting on their polling tick.
 *
 * `reason` lets the renderer decide whether to re-fetch on top of
 * the embedded payload (e.g. background quota refresh follow-up).
 *
 * `quotaStatus` is included so the floating widget and dashboard
 * can update without an extra `getQuotaStatus()` round-trip.
 */
export interface ProviderAuthUpdatedPayload {
  readonly reason:
    | 'created'
    | 'deleted'
    | 'updated'
    | 'imported'
    | 'quota-refreshed';
  readonly rows: readonly ProviderAuthMetadata[];
  readonly quotaStatus: QuotaStatus;
}

export interface DesktopPushPayloads {
  'dashboard.updated': DashboardState;
  'openclash.updated': OpenClashDetails;
  'navigate-tab': string;
  'settings.updated': AppSettings;
  'provider-auth.updated': ProviderAuthUpdatedPayload;
}

export interface UpdateSecretInput {
  key: string;
  value: string;
}

/** Input for `desktop:resizeCompactWindow`. */
export interface ResizeCompactWindowInput {
  width?: number | undefined;
  height: number;
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
  resizeCompactWindow(input: ResizeCompactWindowInput): Promise<void>;
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
  // CPA quota import (cpa-quota-import task 10.4).
  // Channel names are whitelisted in `src/main/ipc/channels.ts` and
  // every payload is validated by the zod schemas in
  // `src/main/schemas.ts` (`desktopApiSchemas`) before reaching the
  // underlying provider-auth / quota services. Returns are
  // structurally redacted — no method on this surface is allowed to
  // hand back a token, refresh token, API key, or the raw CPA file
  // contents (Requirement 1.4).
  listProviderAuths(): Promise<ProviderAuthMetadata[]>;
  importProviderAuthFile(input: {
    provider: ProviderId;
  }): Promise<ProviderAuthMetadata>;
  /**
   * Create a new `provider_auth` row from a manually-typed API key.
   * Only API-key providers (`gemini-api`, `deepseek`, `xiaomi`,
   * `openai-compatible`) accept this entry; OAuth providers must go
   * through `importProviderAuthFile`. The returned metadata is
   * structurally redacted — the API key is never echoed back.
   */
  createProviderAuthApiKey(
    input: CreateProviderAuthApiKeyInput,
  ): Promise<ProviderAuthMetadata>;
  deleteProviderAuth(input: { id: string }): Promise<void>;
  /**
   * Toggle the per-account `enabled` flag. Disabling clears the
   * account's quota cache; enabling makes it eligible for the next
   * scheduled refresh. Returns the updated metadata, or `null` when
   * the id does not exist (idempotent — same shape as `delete`).
   */
  setProviderAuthEnabled(
    input: SetProviderAuthEnabledInput,
  ): Promise<ProviderAuthMetadata | null>;
  refreshProviderQuota(input?: {
    id?: string;
    provider?: ProviderId;
  }): Promise<QuotaStatus>;
  validateProviderAuth(input: { id: string }): Promise<{
    ok: boolean;
    code: ProviderAuthErrorCode | 'ok';
    message: string;
  }>;
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
