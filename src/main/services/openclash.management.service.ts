// OpenClash management client (LuCI / OpenClash plugin endpoints) —
// session layer.
//
// References:
//   - .kiro/specs/network-quick-actions/design.md
//       §`openclash.management.service.ts` — LuCI Management Client
//       §Session caching (in-memory cookie + 401-retry semantics)
//       §Property 5 (Management client honors single-write, ≤3-verify,
//                    no-retry, closed error set)
//       §Property 13 (collector_health.openclash.management counters)
//   - .kiro/specs/network-quick-actions/requirements.md
//       Requirement 5.4, 5.6, 5.8, 5.9 (verify-window, error mapping)
//       Requirement 7.1, 7.2 (no auto-retry on the write step)
//       Requirement 12.1 (encrypted credentials via safeStorage)
//       Requirement 12.5 (clearing creds invalidates cached session)
//       Requirement 15.4, 15.5 (≤1 write, ≤3 verify reads, ≥1000 ms gap)
//       Requirement 16.1 (closed `ManagementErrorCode` set)
//   - docs/postmortems/openclash-management-transport.md
//       The 2026-05-28 transport rewrite: why we no longer use
//       LuCI ubus's `uci.set` + `uci.commit` + `file.exec`.
//
// Tasks 8.1, 8.2, 8.3 and 8.4 are landed:
//
//   - 8.1 — Public types, dependency-injection contract, and the
//           in-memory session-cookie cache that `invalidateSession()`
//           clears.
//   - 8.2 — `ensureSession()` private helper that performs a
//           `POST /cgi-bin/luci` form login and captures the
//           `sysauth` / `sysauth_http` cookie, plus a closure-local
//           `privilegedFetch` wrapper that attaches the cookie,
//           applies `AbortSignal.timeout(requestTimeoutMs)`, and on a
//           401 transparently re-logins **once** before returning the
//           response to the caller. The cookie lives only in process
//           memory.
//   - 8.3 — `readActiveConfigPath()` issues
//           `GET /cgi-bin/luci/admin/services/openclash/config_name`
//           via the closure-local `privilegedFetch` helper. The
//           OpenClash plugin returns the active config as a basename;
//           we normalise it to an absolute path via
//           `canonicalConfigPath()` so the rest of the codebase only
//           ever sees `/etc/openclash/config/<name>`. HTTP errors are
//           funnelled into the closed `ManagementErrorCode` set, all
//           error messages pass the redaction sieve, and the
//           `openclash.management` row of `collector_health` is
//           updated on every call.
//   - 8.4 — `switchActiveConfig()` issues a single write transaction
//           (`POST /cgi-bin/luci/admin/services/openclash/switch_config`
//           with `config_file=<targetPath>`) and then runs a
//           ≤3-iteration verify loop that re-reads `config_name` and
//           probes `GET /configs` in parallel with a 2 s sub-timeout
//           per call. The write step is never auto-retried; on write
//           failure the function returns the mapped closed-set error
//           code without issuing any verify reads.
//
// Why not LuCI ubus
// -----------------
//
// The original design (Q3 in design.md) called for ubus
// `uci.set` + `uci.commit` + `file.exec /etc/init.d/openclash restart`.
// Field testing on iStoreOS (OpenWrt 19.x derivative) showed that the
// LuCI cookie session, despite being granted `uci read+write`, is
// NOT granted `file.exec` under the default rpcd ACL — every restart
// attempt returned ubus status 6 (PERMISSION_DENIED). The fix is to
// route writes through OpenClash's own LuCI plugin endpoints, which
// run their lua handlers as root and therefore bypass the rpcd ACL
// ceiling entirely. See
// `docs/postmortems/openclash-management-transport.md` for the
// probe data and the full reasoning.
//
// Determinism / failure contract (session layer)
// ----------------------------------------------
//
// - The factory returns synchronously and performs **no I/O**. No
//   `fetch`, no `secrets.get`, no SQLite write happens until one of
//   the (future) real methods is invoked or `privilegedFetch` is
//   called by a follow-up task.
// - The session cookie lives only in process memory, on the closure
//   variable `cachedSessionCookie`. It is `null` at construction and
//   after every `invalidateSession()` call, and after a 401 response
//   that triggers the transparent re-login path (the old cookie is
//   cleared **before** the second login is attempted, so a concurrent
//   `invalidateSession()` always wins the race).
// - Every fetch issued by this module is wrapped with
//   `AbortSignal.timeout(timeoutMs)`. The timeout falls back to
//   `getAppSettings().managementInterface.requestTimeoutMs` when the
//   caller does not pass one.
// - The interface is intentionally narrow: `readActiveConfigPath`,
//   `switchActiveConfig`, and `invalidateSession` are the only
//   methods callers ever need. `ensureSession` and `privilegedFetch`
//   live on the closure (they are exported on the deps shape only
//   as a future implementation hook, not on the public client
//   interface).

import type { CollectorHealthRepository } from '../store/repositories';
import type { SecretsModule } from '../security/secrets';
import type { AppSettings } from '../types';

// ---------------------------------------------------------------------------
// Public surface — types
// ---------------------------------------------------------------------------

/**
 * Closed set of error codes the management client may surface.
 *
 * Mirrors design.md §`openclash.management.service.ts` interface and
 * is the **single source of truth** consumed by:
 *   - `ConfigSwitchResult.error.code` returned from this module
 *   - `openclash_config_changes.result_code` (audit table)
 *   - `collector_health.last_error` for the `openclash.management` row
 *   - the renderer's `formatManagementError` i18n map
 *
 * `switch_in_progress` is **not** part of this set — it is owned by
 * the IPC orchestrator's lock-arbitration path (Requirement 9.2),
 * which returns before this client is ever invoked.
 */
export type ManagementErrorCode =
  /** 401, invalid creds, session expired and re-login failed. */
  | 'auth_error'
  /** Non-2xx, non-401 HTTP response from LuCI. */
  | 'http_error'
  /** DNS / ECONNREFUSED / abort / per-request timeout. */
  | 'network_error'
  /** Verify window exhausted (or the 3-read budget is) without a confirmed flip. */
  | 'verify_timeout'
  /** Verify saw a path different from `targetPath` within the budget. */
  | 'verify_mismatch'
  /** `managementInterface.kind` is not implemented on this build. */
  | 'not_supported';

/**
 * UI- / audit-safe error envelope. `message` MUST NEVER contain
 * `Authorization` headers, request bodies, response bodies, or any
 * value present in the `secrets` table — the redaction sieve in
 * tasks 8.3 / 8.4 is responsible for enforcing that.
 */
export interface ManagementError {
  readonly code: ManagementErrorCode;
  readonly message: string;
}

/**
 * Result of a single `switchActiveConfig` call. The shape mirrors
 * design.md so the orchestrator's audit writer (task 6.1) can copy
 * `startPath` / `targetPath` / `finalPath` straight onto the
 * `'end'` row without re-reading the management client.
 */
export interface ConfigSwitchResult {
  readonly ok: boolean;
  /** Active config the client read just before the write step. `null` if the read failed or was skipped. */
  readonly startPath: string | null;
  readonly targetPath: string;
  /** Active config observed by the verify loop. `null` when no read succeeded. */
  readonly finalPath: string | null;
  /** Present iff `ok === false`. */
  readonly error?: ManagementError;
}

/** Per-call request options. Currently only a timeout override. */
export interface ManagementRequestOptions {
  /** Override the per-request timeout (ms). Falls back to `managementInterface.requestTimeoutMs`. */
  readonly timeoutMs?: number;
}

/** Inputs for {@link OpenClashManagementClient.switchActiveConfig}. */
export interface SwitchActiveConfigInput {
  readonly targetPath: string;
  /** 1000..30000 ms — orchestrator passes `settings.configSwitchVerifyWindowMs`. */
  readonly verifyWindowMs: number;
  /** 1000..30000 ms — orchestrator passes `settings.managementInterface.requestTimeoutMs`. */
  readonly requestTimeoutMs: number;
}

/**
 * Public surface of the management client. The factory below returns
 * an instance of this interface; tasks 8.2..8.4 fill in the bodies of
 * the read / switch methods.
 */
export interface OpenClashManagementClient {
  /**
   * Read `uci openclash.config.config_path`.
   *
   * @throws ManagementError on failure (delivered as a thrown object;
   *         the orchestrator wraps it into a richer `ConfigSwitchResult`
   *         when this is part of a switch flow).
   *
   * **Skeleton stub**: always rejects with `not_supported` until task 8.3
   * lands.
   */
  readActiveConfigPath(opts?: ManagementRequestOptions): Promise<string>;

  /**
   * Set + commit the active config path then restart OpenClash.
   *
   * Performs **at most one** write transaction (`uci.set` + `uci.commit`
   * + `restart`) and **at most three** verify reads spaced ≥ 1000 ms
   * apart, all bounded by `verifyWindowMs + requestTimeoutMs`. Never
   * auto-retries the write step (Property 8 carryover).
   *
   * **Skeleton stub**: always resolves with
   * `{ ok: false, error: { code: 'not_supported', ... } }` until
   * task 8.4 lands. The stub deliberately resolves rather than
   * throws because `ConfigSwitchResult` is the orchestrator's normal
   * return path and a thrown error here would force every caller to
   * thread a try/catch around an interface that promises to be
   * total.
   */
  switchActiveConfig(input: SwitchActiveConfigInput): Promise<ConfigSwitchResult>;

  /**
   * Tear down the cached cookie session. Idempotent: calling on a
   * client whose session cache is already empty is a no-op. Used by
   * `clearManagementCredentials` (task 10.5) so a credential clear
   * cannot leave a stale cookie behind.
   */
  invalidateSession(): void;
}

// ---------------------------------------------------------------------------
// Public surface — dependencies
// ---------------------------------------------------------------------------

/**
 * `fetch` shape accepted by the client. Defaults to `globalThis.fetch`
 * in production; tests inject a stub. Matches the WHATWG signature so
 * either Node 20+ built-in fetch or a polyfill can satisfy it.
 */
export type ManagementFetch = typeof fetch;

/**
 * Function the client uses during the verify loop to ask "is the
 * Clash controller answering?". Returns `true` iff a `GET /configs`
 * call returned a 2xx (kernel up) or 401 (kernel up but auth
 * required) within `timeoutMs`. The client never inspects the body —
 * it only needs the liveness signal.
 *
 * Wired in production to a thin wrapper around the existing
 * `OpenClashClient.getConfigs` (catches both `AuthError` → `true` and
 * any other thrown class → `false`); tests inject a deterministic
 * stub for Property 5.
 */
export type ControllerHealthcheck = (opts: {
  readonly timeoutMs: number;
}) => Promise<boolean>;

export interface OpenClashManagementClientDeps {
  /**
   * HTTP transport. Defaults to `globalThis.fetch`. Tests inject a
   * stub to drive the LuCI surface deterministically.
   */
  readonly fetch?: ManagementFetch;
  /**
   * Wall-clock source. Defaults to `Date.now`. Used by the verify
   * loop's gap accounting (≥ 1000 ms between reads) and by the
   * `collector_health` row's timestamp columns.
   */
  readonly now?: () => number;
  /**
   * Secrets module used to read `openclash.management.username` and
   * `openclash.management.password` lazily on every login attempt.
   * The client never caches plaintext credentials beyond the in-
   * flight `POST /cgi-bin/luci` call.
   */
  readonly secrets: SecretsModule;
  /**
   * Repository used to update the `openclash.management` row of
   * `collector_health` after every call (Property 13). The client
   * writes only the closed `ManagementErrorCode` literals plus an
   * optional short tag — never `Authorization` headers, request
   * bodies, response bodies, or password values (Requirement 14.5).
   */
  readonly collectorHealthRepo: CollectorHealthRepository;
  /**
   * Liveness check against the Clash controller used by the verify
   * loop's `apiOk` half. See {@link ControllerHealthcheck}.
   */
  readonly controllerHealthcheck: ControllerHealthcheck;
  /**
   * Live read of the persisted {@link AppSettings}. A getter (not a
   * captured value) so user edits to
   * `managementInterface.url` / `requestTimeoutMs` /
   * `configSwitchVerifyWindowMs` take effect on the very next call
   * without reconstructing the client.
   */
  readonly getAppSettings: () => AppSettings;
  /**
   * Sleep helper used by the verify loop to enforce the ≥ 1000 ms
   * gap between consecutive verify reads (Requirement 15.4). Defaults
   * to a `setTimeout`-backed promise; tests inject a deterministic
   * stub so a fake clock can advance without sitting on a real
   * `setTimeout`.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Cached LuCI session. Built by task 8.2's `ensureSession()` after a
 * successful `POST /cgi-bin/luci` login. The skeleton only reserves
 * the slot and exposes `invalidateSession()` to clear it.
 *
 * Stored as a discriminated nullable so future code can carry both
 * the cookie and any associated metadata (e.g. `tokenIssuedAt` for a
 * proactive refresh) without breaking the shape used here.
 */
interface CachedSession {
  /**
   * Raw `Cookie` header value (e.g. `sysauth=…; sysauth_http=…`).
   * Process-memory only — never persisted to disk, never logged,
   * never echoed across the IPC boundary.
   */
  readonly cookie: string;
  /** Wall-clock timestamp the cookie was first observed (ms). */
  readonly issuedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Row key in the `collector_health` table updated by every management
 * call (Property 13 / Requirement 14). Single source of truth so the
 * read and switch paths cannot drift.
 */
const MANAGEMENT_COLLECTOR_KEY = 'openclash.management';

/**
 * Absolute-path prefix every OpenClash config file lives under. The
 * OpenClash LuCI plugin's `action_config_name` returns the active
 * file as a **basename** (e.g. `iKuuu.yaml`); we always re-attach
 * this prefix before exposing the path to the rest of the codebase
 * (audit table, IPC payloads, UI) so callers see a single canonical
 * shape (`/etc/openclash/config/<name>`).
 *
 * The schema's `CONFIG_PATH_RE` validator (in `schemas.ts`) pins the
 * same prefix on user-supplied whitelist entries, so absolute and
 * canonical-from-basename paths are byte-for-byte equal.
 */
const OPENCLASH_CONFIG_DIR = '/etc/openclash/config/';

/**
 * Absolute LuCI URL paths for the OpenClash plugin endpoints. These
 * are stable across upstream OpenClash versions (defined by
 * `luci-app-openclash/luasrc/controller/openclash.lua`). Using the
 * plugin's own routes lets us bypass the LuCI ubus rpcd ACL ceiling
 * — `action_switch_config` runs the `uci.set` + `uci.commit` +
 * `/etc/init.d/openclash restart` sequence as root inside the lua
 * handler, which the cookie session is allowed to invoke even
 * though direct ubus `file.exec` is not.
 */
const OPENCLASH_CONFIG_NAME_PATH =
  '/cgi-bin/luci/admin/services/openclash/config_name';
const OPENCLASH_SWITCH_CONFIG_PATH =
  '/cgi-bin/luci/admin/services/openclash/switch_config';

/**
 * Hard ceiling on verify-loop iterations (Requirement 15.4 / Property 5).
 * The loop also exits early when `verifyWindowMs` elapses, whichever
 * comes first.
 */
const VERIFY_MAX_ITERATIONS = 3;

/**
 * Minimum gap (ms) between consecutive verify-read iterations
 * (Requirement 15.4). Enforced by `sleep` in the verify loop; the
 * first iteration runs without any pre-sleep so that a snappy backend
 * can flip within a few hundred ms of the restart.
 */
const VERIFY_MIN_GAP_MS = 1000;

/**
 * Per-call sub-timeout (ms) used inside the verify loop for both the
 * `config_name` re-read and the `GET /configs` controller liveness
 * probe (design.md §`openclash.management.service.ts` §Verify).
 * Independent of `requestTimeoutMs` because the verify reads must be
 * tight even when the user has dialled `requestTimeoutMs` up for slow
 * links.
 */
const VERIFY_SUBCALL_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// OpenClash plugin response parsing helpers
// ---------------------------------------------------------------------------

/**
 * Type guard for the {@link ManagementError} envelope. Used by the
 * read path to distinguish a `ManagementError` thrown by the session
 * helpers from any other unexpected error class.
 */
function isManagementError(value: unknown): value is ManagementError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof (value as { code: unknown }).code === 'string'
  );
}

/**
 * Normalise a value returned by the OpenClash plugin's
 * `action_config_name` (or any other source that may use a basename
 * instead of an absolute path) to the canonical absolute form
 * `/etc/openclash/config/<name>`.
 *
 * Accepts:
 *   - `/etc/openclash/config/iKuuu.yaml`  (absolute, returned as-is)
 *   - `iKuuu.yaml`                        (basename, prefix re-attached)
 *
 * Returns `null` when the value is not a non-empty string or contains
 * a path separator that would let it escape the config directory
 * (defense in depth — the upstream lua handler already rejects
 * traversal, but we never echo unsanitised input out of this module).
 */
function canonicalConfigPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith(OPENCLASH_CONFIG_DIR)) {
    // Already absolute. Reject anything that tries to climb out of
    // the config dir; the schema validator pins the same shape on
    // whitelist entries, so this is just defense in depth against a
    // misbehaving upstream.
    const tail = trimmed.slice(OPENCLASH_CONFIG_DIR.length);
    if (tail.length === 0 || tail.includes('/') || tail.includes('\\')) {
      return null;
    }
    return trimmed;
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    // Relative path with separators is unexpected — refuse rather
    // than guess.
    return null;
  }
  return OPENCLASH_CONFIG_DIR + trimmed;
}

/**
 * Extract the active config path from the JSON returned by
 * `GET /cgi-bin/luci/admin/services/openclash/config_name`. The
 * upstream `action_config_name` handler (see
 * `luci-app-openclash/luasrc/controller/openclash.lua`) returns:
 *
 * ```json
 * {
 *   "config_name": [{ "name": "WestData.yaml" }, { "name": "iKuuu.yaml" }],
 *   "config_path": "iKuuu.yaml"
 * }
 * ```
 *
 * We only care about `config_path`. Returns `null` when the field is
 * missing, empty, or fails the canonical-path normalisation.
 */
function extractConfigPathFromConfigName(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  return canonicalConfigPath(record.config_path);
}

/**
 * Parsed shape of the OpenClash plugin's `switch_config` reply. The
 * upstream handler always returns a JSON object whose `status` field
 * is either `"success"` or `"error"`; on the latter `message` carries
 * a short reason ("No config file specified" or "Config file does
 * not exist: ..."). We deliberately ignore everything else so a
 * future schema drift can only narrow our acceptance, never widen it.
 */
interface SwitchConfigReply {
  readonly status: 'success' | 'error' | 'unknown';
  readonly message: string | null;
}

function parseSwitchConfigReply(payload: unknown): SwitchConfigReply {
  if (payload === null || typeof payload !== 'object') {
    return { status: 'unknown', message: null };
  }
  const record = payload as Record<string, unknown>;
  const rawStatus = record.status;
  const rawMessage = record.message;
  const message =
    typeof rawMessage === 'string' && rawMessage.length > 0
      ? rawMessage
      : null;
  if (rawStatus === 'success') {
    return { status: 'success', message };
  }
  if (rawStatus === 'error') {
    return { status: 'error', message };
  }
  return { status: 'unknown', message };
}

/**
 * Best-effort drain of a fetch `Response` body. Used to release the
 * underlying socket back to the pool before we throw on a non-2xx
 * outcome. Never propagates a body-read failure — that would mask
 * the primary HTTP outcome we are about to surface.
 */
async function drainResponseBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Ignored: the connection will be closed by GC if the runtime
    // can't drain it cleanly.
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (task 8.2)
// ---------------------------------------------------------------------------

/**
 * Build a {@link ManagementError} envelope without leaking sensitive
 * material. The caller is expected to have already applied any
 * URL/credential redaction to `message` (see {@link redactUrlCredentials}).
 */
function managementError(
  code: ManagementErrorCode,
  message: string,
): ManagementError {
  return { code, message };
}

/**
 * Classify a fetch rejection's cause into a short tag suitable for an
 * audit-safe error message. Mirrors `classifyCause` in
 * `openclash.service.ts` so the management client speaks the same
 * vocabulary as the controller client.
 *
 * Node's `fetch` raises a `TypeError` whose `cause` carries the
 * underlying Undici error; aborts surface as a `DOMException` with
 * name `AbortError` or `TimeoutError` (the latter from
 * `AbortSignal.timeout`). We never thread the original `message`
 * through because LuCI bodies / DPAPI errors can contain plaintext
 * fragments — only the `name` field is exposed.
 */
function classifyFetchCause(cause: unknown): string {
  if (cause === undefined || cause === null) {
    return 'network_error';
  }
  if (typeof cause === 'object' && 'name' in cause) {
    const name = (cause as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) {
      if (name === 'TimeoutError' || name === 'AbortError') {
        return 'timeout';
      }
      return name;
    }
  }
  return 'network_error';
}

/**
 * Strip any `username:password@` prefix from a URL string so that
 * defense-in-depth keeps embedded credentials out of error messages
 * even though `managementUrlSchema` already rejects URLs with
 * userinfo (Property 11). On parse failure the input is returned
 * verbatim — we never throw from the redaction path.
 */
function redactUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username === '' && parsed.password === '') {
      return parsed.toString();
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value;
  }
}

/**
 * Compose a request URL by concatenating a (trailing-slash-tolerant)
 * base with an absolute path. The LuCI surface uses absolute paths
 * (`/cgi-bin/luci/...`, `/cgi-bin/luci/admin/services/openclash/...`)
 * so we deliberately strip any path component on `base` to keep
 * callers honest.
 */
function joinManagementUrl(base: string, path: string): string {
  // `URL` handles both `http://1.2.3.4` and `http://1.2.3.4/luci/`
  // gracefully; we always replace the pathname/search/hash so the
  // caller's `path` is the single source of truth for the request.
  const parsed = new URL(base);
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Pull the `sysauth` / `sysauth_http` cookie pair(s) out of a LuCI
 * login response. Returns the joined `name=value[; name=value]`
 * string suitable for use as a `Cookie:` request header, or `null`
 * when neither cookie is present (which on a 200 response is
 * indistinguishable from "credentials rejected" — LuCI re-renders
 * the login form in that case).
 *
 * We deliberately strip cookie attributes (`Path=`, `HttpOnly`,
 * `SameSite=...`, `Expires=...`) — they are server-side directives
 * that have no meaning on outbound `Cookie:` headers.
 */
function extractSysAuthCookie(response: Response): string | null {
  // `Headers.getSetCookie()` returns an array of raw `Set-Cookie`
  // values without the comma-folding that `get('set-cookie')` would
  // perform. Available in Node 20+ and on Undici's response headers.
  const rawCookies = response.headers.getSetCookie();
  const captured: string[] = [];
  for (const raw of rawCookies) {
    const semicolon = raw.indexOf(';');
    const pair = (semicolon >= 0 ? raw.slice(0, semicolon) : raw).trim();
    const equals = pair.indexOf('=');
    if (equals <= 0) {
      continue;
    }
    const name = pair.slice(0, equals).trim();
    if (name === 'sysauth' || name === 'sysauth_http') {
      captured.push(pair);
    }
  }
  if (captured.length === 0) {
    return null;
  }
  return captured.join('; ');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct an {@link OpenClashManagementClient}.
 *
 * The factory is synchronous and performs no I/O — it only captures
 * its dependencies and initialises the session-cookie cache to
 * `null`. Tasks 8.2 / 8.3 / 8.4 wire up `ensureSession()` /
 * `privilegedFetch`, the `readActiveConfigPath()` plugin call, and
 * the full `switchActiveConfig()` write + verify loop respectively.
 */
export function createOpenClashManagementClient(
  deps: OpenClashManagementClientDeps,
): OpenClashManagementClient {
  // Resolve the optional dependencies up front so the closures below
  // do not have to re-check `undefined` on every call.
  const fetchImpl: ManagementFetch =
    deps.fetch ?? globalThis.fetch.bind(globalThis);
  const now: () => number = deps.now ?? Date.now;
  const sleep: (ms: number) => Promise<void> =
    deps.sleep ??
    ((ms: number) =>
      ms <= 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
          }));
  const {
    secrets,
    collectorHealthRepo,
    controllerHealthcheck,
    getAppSettings,
  } = deps;

  /**
   * In-memory session cookie cache. Set by {@link ensureSession} after
   * a successful `POST /cgi-bin/luci` login; cleared by
   * `invalidateSession` and by `clearManagementCredentials`
   * (task 10.5).
   *
   * Never persisted to disk, never logged, never serialised across
   * the IPC boundary. The closure variable is the **only** place the
   * cookie ever lives.
   */
  let cachedSessionCookie: CachedSession | null = null;

  /**
   * Resolve the per-request timeout (ms). Per design.md
   * §`openclash.management.service.ts` the default comes from
   * `managementInterface.requestTimeoutMs`; callers may override on
   * a per-call basis (used by the verify loop's `apiOk` half).
   */
  function resolveTimeoutMs(opts?: ManagementRequestOptions): number {
    const fallback = getAppSettings().managementInterface.requestTimeoutMs;
    return opts?.timeoutMs ?? fallback;
  }

  /**
   * Read both LuCI credentials from `secrets`. A missing or empty
   * value on either key is treated as "credentials not configured"
   * and is surfaced as `auth_error` — the same code the orchestrator
   * uses for "creds wrong", because from the user's perspective
   * "creds missing" and "creds rejected" are the same problem.
   *
   * `secrets.get` may also throw `SecretsUnavailableError` /
   * `SecretsDecryptError` when the OS encryption layer is down; we
   * map those to `auth_error` too — the user must reconfigure
   * credentials before any privileged call can succeed.
   */
  function loadCredentials(): { username: string; password: string } {
    let username: string | null;
    let password: string | null;
    try {
      username = secrets.get('openclash.management.username');
      password = secrets.get('openclash.management.password');
    } catch (cause) {
      const tag = cause instanceof Error ? cause.name : 'unavailable';
      throw managementError(
        'auth_error',
        `OpenClash management credentials unavailable (${tag})`,
      );
    }
    if (
      username === null ||
      username.length === 0 ||
      password === null ||
      password.length === 0
    ) {
      throw managementError(
        'auth_error',
        'OpenClash management credentials are not configured',
      );
    }
    return { username, password };
  }

  /**
   * `POST /cgi-bin/luci` with form-encoded `luci_username` +
   * `luci_password`. Returns the captured `sysauth`/`sysauth_http`
   * cookie. On any non-cookie outcome (form re-render, 401, 5xx,
   * fetch error) throws a {@link ManagementError} with the
   * appropriate closed-set code.
   *
   * LuCI's login endpoint is the path `/cgi-bin/luci` with no
   * sub-action — it accepts either `application/x-www-form-urlencoded`
   * or a multipart form, and on success replies with `302` (or
   * sometimes `200`) and one or more `Set-Cookie: sysauth=...`
   * headers. On invalid creds it re-renders the login HTML with a
   * `200` status and **no** session cookie, which is exactly the
   * "neither cookie present" branch in {@link extractSysAuthCookie}.
   *
   * NOTE: `redirect: 'manual'` keeps the cookie attached to the
   * `302` response — Node's default `'follow'` would discard the
   * `Set-Cookie` header by following to the next page before our
   * code sees it.
   */
  async function login(timeoutMs: number): Promise<string> {
    const settings = getAppSettings();
    const baseUrl = settings.managementInterface.url;
    if (baseUrl.length === 0) {
      throw managementError(
        'auth_error',
        'OpenClash management URL is not configured',
      );
    }

    const { username, password } = loadCredentials();
    const url = joinManagementUrl(baseUrl, '/cgi-bin/luci');
    const safeUrl = redactUrlCredentials(url);

    const body = new URLSearchParams({
      luci_username: username,
      luci_password: password,
    }).toString();

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html, */*;q=0.1',
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const tag = classifyFetchCause(cause);
      throw managementError(
        'network_error',
        `POST ${safeUrl}: ${tag}`,
      );
    }

    // 302 with a Set-Cookie is the canonical success shape; some
    // LuCI builds return 200 instead. Either way the cookie has to
    // be present — its absence on a 200 is LuCI's way of saying
    // "credentials rejected".
    const cookie = extractSysAuthCookie(response);
    if (cookie !== null && (response.status === 200 || response.status === 302)) {
      return cookie;
    }

    // Drain the body so the underlying socket can be released.
    // We never inspect or surface the body — LuCI returns the full
    // admin HTML on auth failure (Requirement 14.5 / 16.1).
    try {
      await response.arrayBuffer();
    } catch {
      // Best-effort drain — never let body-read failures mask the
      // primary login outcome.
    }

    if (response.status === 401 || response.status === 403) {
      throw managementError(
        'auth_error',
        `POST ${safeUrl}: ${response.status}`,
      );
    }
    // 200 / 302 without a cookie => LuCI rejected the creds.
    if (response.status === 200 || response.status === 302) {
      throw managementError(
        'auth_error',
        `POST ${safeUrl}: rejected`,
      );
    }
    // Anything else is server-side breakage (5xx, 404 if the URL is
    // wrong, etc.).
    throw managementError(
      'http_error',
      `POST ${safeUrl}: ${response.status}`,
    );
  }

  /**
   * Ensure a valid LuCI session cookie is cached, performing a
   * `login()` round trip when the cache is empty. Returns the
   * `Cookie:` header string the caller should attach to its next
   * request.
   *
   * Idempotent against a populated cache — repeated calls reuse the
   * same cookie until {@link invalidateSession} clears it (or until
   * {@link privilegedFetch} sees a 401 and tears it down).
   */
  async function ensureSession(timeoutMs: number): Promise<string> {
    if (cachedSessionCookie !== null) {
      return cachedSessionCookie.cookie;
    }
    const cookie = await login(timeoutMs);
    cachedSessionCookie = { cookie, issuedAt: now() };
    return cookie;
  }

  /**
   * Build a `RequestInit` that attaches the cached session cookie
   * (re-logging in first when the cache is empty) and applies a
   * per-request `AbortSignal.timeout`. Caller-provided headers
   * win over `Cookie:` only if the caller deliberately overrides
   * it — the management client never has a reason to do that and
   * we leave the helper conservative.
   */
  async function buildAuthenticatedInit(
    init: RequestInit,
    timeoutMs: number,
  ): Promise<RequestInit> {
    const cookie = await ensureSession(timeoutMs);
    const headers = new Headers(init.headers);
    if (!headers.has('Cookie')) {
      headers.set('Cookie', cookie);
    }
    return {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
  }

  /**
   * Issue a privileged `fetch` against the LuCI surface with one
   * transparent re-login retry on a 401 response.
   *
   * Behaviour (per design.md §`openclash.management.service.ts`
   * §Session caching):
   *
   *   1. Resolve the per-request timeout.
   *   2. Acquire the cached session cookie (logging in lazily).
   *   3. Send the request with the cookie attached and
   *      `AbortSignal.timeout(timeoutMs)`.
   *   4. On a 401 response: invalidate the cached cookie, re-login
   *      once, and retry the request **exactly once**. If the retry
   *      also returns 401, the caller receives the 401 response and
   *      is responsible for mapping it to `auth_error`.
   *   5. Network failures (DNS, ECONNREFUSED, abort, timeout) and
   *      auth-not-configured errors propagate as thrown
   *      {@link ManagementError} envelopes — the caller never has
   *      to distinguish "fetch threw" from "secrets rejected".
   *
   * The helper does NOT classify non-2xx responses other than 401:
   * 5xx / 404 / 403 mapping is the caller's responsibility because
   * different LuCI endpoints have different "soft 200 with an error
   * envelope" conventions.
   *
   * Task 8.3 / 8.4 will be the first callers; the helper is
   * exposed inside the closure (not on the public interface) so
   * the renderer can never reach it.
   */
  async function privilegedFetch(
    url: string,
    init: RequestInit = {},
    opts?: ManagementRequestOptions,
  ): Promise<Response> {
    const timeoutMs = resolveTimeoutMs(opts);
    const safeUrl = redactUrlCredentials(url);
    const method = (init.method ?? 'GET').toUpperCase();

    let firstInit: RequestInit;
    try {
      firstInit = await buildAuthenticatedInit(init, timeoutMs);
    } catch (cause) {
      // `loadCredentials` / `login` already throw a ManagementError
      // shape; rethrow verbatim so the caller's catch sees it.
      throw cause;
    }

    let response: Response;
    try {
      response = await fetchImpl(url, firstInit);
    } catch (cause) {
      const tag = classifyFetchCause(cause);
      throw managementError(
        'network_error',
        `${method} ${safeUrl}: ${tag}`,
      );
    }

    if (response.status !== 401) {
      return response;
    }

    // Drain the failed body so the socket can be released before we
    // attempt the re-login round trip.
    try {
      await response.arrayBuffer();
    } catch {
      // Ignore drain failures.
    }

    // Single transparent re-login + retry. If the second pass also
    // returns 401, the caller maps it to `auth_error` (the closed
    // error set keeps that classification at the policy boundary,
    // not in this transport helper).
    cachedSessionCookie = null;

    let retryInit: RequestInit;
    try {
      retryInit = await buildAuthenticatedInit(init, timeoutMs);
    } catch (cause) {
      // Re-login itself failed (creds rejected, network down,
      // creds missing). Propagate the ManagementError verbatim.
      throw cause;
    }

    let retryResponse: Response;
    try {
      retryResponse = await fetchImpl(url, retryInit);
    } catch (cause) {
      const tag = classifyFetchCause(cause);
      throw managementError(
        'network_error',
        `${method} ${safeUrl} (retry): ${tag}`,
      );
    }

    return retryResponse;
  }

  /**
   * Apply the redaction sieve to an error message before it leaves
   * the management client. The sieve enforces the three rules from
   * design.md §`openclash.management.service.ts` §Diagnostics safety:
   *
   *   1. URL-redact userinfo (already applied by callers via
   *      {@link redactUrlCredentials}; this is defense in depth).
   *   2. Mask any substring equal to a current secret value with
   *      `<redacted>`.
   *   3. Body excerpts capped at 0 bytes — enforced by the call
   *      sites (we never read the response body into a message).
   *
   * Returns `message` unchanged when no secret values are loadable
   * (e.g. `safeStorage` is unavailable or the keys are not set) —
   * a missing sieve must never fail the call it is sieving.
   */
  function redactSecretValues(message: string): string {
    const values: string[] = [];
    for (const key of [
      'openclash.management.username',
      'openclash.management.password',
    ]) {
      try {
        const value = secrets.get(key);
        if (typeof value === 'string' && value.length > 0) {
          values.push(value);
        }
      } catch {
        // Secrets unavailable on this profile; nothing to mask.
        // The error message is already free of bodies / Authorization
        // headers / cookies by construction.
      }
    }
    let out = message;
    for (const value of values) {
      if (value.length > 0 && out.includes(value)) {
        out = out.split(value).join('<redacted>');
      }
    }
    return out;
  }

  /**
   * Build a sieved {@link ManagementError}. Mirrors
   * {@link managementError} but pushes the message through
   * {@link redactSecretValues} first so callers cannot accidentally
   * forget the redaction step.
   */
  function sievedError(
    code: ManagementErrorCode,
    message: string,
  ): ManagementError {
    return managementError(code, redactSecretValues(message));
  }

  /**
   * Record a successful management call against the
   * `openclash.management` row of `collector_health` (Property 13 /
   * Requirement 14.2).
   *
   * Repository writes are wrapped in try/catch so a transient SQLite
   * fault (e.g. WAL contention) cannot mask the real method's
   * outcome — health bookkeeping is best-effort.
   */
  function recordCollectorSuccess(at: number): void {
    try {
      collectorHealthRepo.recordSuccess(MANAGEMENT_COLLECTOR_KEY, at);
    } catch {
      // Best-effort; collector_health is observability, not a hard
      // dependency of the call's correctness contract.
    }
  }

  /**
   * Record a failed management call against the
   * `openclash.management` row of `collector_health` (Property 13 /
   * Requirement 14.3).
   *
   * Stores **only** the closed `ManagementErrorCode` literal — never
   * the underlying message, body, or Authorization value. This keeps
   * the row safe from secret leakage (Requirement 14.5) and lets the
   * dashboard layer i18n the code without parsing free-form text.
   */
  function recordCollectorFailure(at: number, code: ManagementErrorCode): void {
    try {
      collectorHealthRepo.recordFailure(MANAGEMENT_COLLECTOR_KEY, at, code);
    } catch {
      // Best-effort; see recordCollectorSuccess.
    }
  }

  /**
   * Issue a single privileged GET / POST against an OpenClash plugin
   * endpoint and return the parsed JSON body. Encapsulates the
   * "200-with-JSON-body" success contract so callers only see the
   * closed-set error mapping.
   *
   * Error mapping (callers never need to second-guess this):
   *   - 401 (after the transparent re-login attempt fails)  → `auth_error`
   *   - any other non-2xx                                    → `http_error`
   *   - body that is not valid JSON                          → `http_error`
   *   - fetch reject (DNS / ECONNREFUSED / abort / timeout)  → `network_error`
   *     (raised by `privilegedFetch` already as the right
   *     `ManagementError`; we forward verbatim)
   *
   * The body is read once, then either parsed or surfaced as an
   * `http_error` — we never echo bytes from the response into the
   * thrown `message` (Requirement 14.5).
   */
  async function pluginCall(
    method: 'GET' | 'POST',
    path: string,
    bodyInit:
      | { kind: 'none' }
      | { kind: 'form'; entries: ReadonlyArray<readonly [string, string]> },
    timeoutMs: number,
  ): Promise<unknown> {
    const settings = getAppSettings();
    const baseUrl = settings.managementInterface.url;
    if (baseUrl.length === 0) {
      throw sievedError(
        'auth_error',
        'OpenClash management URL is not configured',
      );
    }

    const url = joinManagementUrl(baseUrl, path);
    const safeUrl = redactUrlCredentials(url);

    const init: RequestInit =
      bodyInit.kind === 'form'
        ? {
            method,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json, */*;q=0.1',
            },
            body: new URLSearchParams(
              bodyInit.entries.map(
                ([k, v]) => [k, v] as [string, string],
              ),
            ).toString(),
          }
        : {
            method,
            headers: {
              Accept: 'application/json, */*;q=0.1',
            },
          };

    const response = await privilegedFetch(url, init, { timeoutMs });

    if (response.status === 401) {
      await drainResponseBody(response);
      throw sievedError('auth_error', `${method} ${safeUrl}: 401`);
    }

    if (!response.ok) {
      await drainResponseBody(response);
      throw sievedError(
        'http_error',
        `${method} ${safeUrl}: ${response.status}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw sievedError('http_error', `${method} ${safeUrl}: invalid JSON`);
    }
    return parsed;
  }

  /**
   * Issue a single
   * `GET /cgi-bin/luci/admin/services/openclash/config_name` and
   * return the active config path normalised to the canonical
   * `/etc/openclash/config/<name>` shape. Throws a
   * {@link ManagementError} on any failure.
   *
   * Shared between {@link readActiveConfigPath} (which adds collector
   * health bookkeeping) and the verify loop in
   * {@link switchActiveConfig} (which records a single aggregate
   * outcome at the end of the switch flow rather than one row per
   * verify read — Property 13 counts switch flows, not internal
   * probes).
   */
  async function readActiveConfigPathOnce(timeoutMs: number): Promise<string> {
    let parsed: unknown;
    try {
      parsed = await pluginCall(
        'GET',
        OPENCLASH_CONFIG_NAME_PATH,
        { kind: 'none' },
        timeoutMs,
      );
    } catch (cause) {
      if (isManagementError(cause)) {
        throw cause;
      }
      throw sievedError(
        'network_error',
        cause instanceof Error
          ? `unexpected error: ${cause.name}`
          : 'unexpected error',
      );
    }

    const path = extractConfigPathFromConfigName(parsed);
    if (path === null) {
      throw sievedError(
        'http_error',
        'GET config_name: missing or malformed config_path',
      );
    }
    return path;
  }

  /**
   * Coerce an unknown rejection into a {@link ManagementError}. Used
   * by the switch-flow paths where we accept a thrown
   * `ManagementError` verbatim and bucket anything else into
   * `network_error` (the closed-set bucket for "the call did not
   * complete").
   */
  function coerceManagementError(cause: unknown): ManagementError {
    if (isManagementError(cause)) {
      return cause;
    }
    return sievedError(
      'network_error',
      cause instanceof Error
        ? `unexpected error: ${cause.name}`
        : 'unexpected error',
    );
  }

  return {
    async readActiveConfigPath(opts?: ManagementRequestOptions): Promise<string> {
      const timeoutMs = resolveTimeoutMs(opts);
      try {
        const path = await readActiveConfigPathOnce(timeoutMs);
        recordCollectorSuccess(now());
        return path;
      } catch (cause) {
        const err = coerceManagementError(cause);
        recordCollectorFailure(now(), err.code);
        throw err;
      }
    },

    async switchActiveConfig(
      input: SwitchActiveConfigInput,
    ): Promise<ConfigSwitchResult> {
      const { targetPath, verifyWindowMs, requestTimeoutMs } = input;

      // -----------------------------------------------------------------
      // 1) Pre-write read of the current active config path.
      //
      // This populates `startPath` for the audit row. A failed read
      // does NOT abort the switch — the user's intent is to flip the
      // path, and the start-path column is observability, not part of
      // the write contract. We swallow any thrown ManagementError and
      // record `startPath = null`.
      // -----------------------------------------------------------------
      let startPath: string | null = null;
      try {
        startPath = await readActiveConfigPathOnce(requestTimeoutMs);
      } catch {
        // Best-effort. The audit row simply has no startPath; this is
        // the same shape the orchestrator already accepts.
      }

      // -----------------------------------------------------------------
      // 2) Single write transaction: POST switch_config.
      //
      // The OpenClash plugin's `action_switch_config` lua handler
      // performs `uci.set` + `uci.commit` + `/etc/init.d/openclash
      // restart` server-side as root, which the cookie session is
      // permitted to invoke even though direct ubus `file.exec` is
      // not (see the file-header postmortem reference). We never
      // auto-retry the write step (Requirement 7.1, Property 8
      // carryover).
      // -----------------------------------------------------------------
      try {
        let parsed: unknown;
        try {
          parsed = await pluginCall(
            'POST',
            OPENCLASH_SWITCH_CONFIG_PATH,
            { kind: 'form', entries: [['config_file', targetPath]] },
            requestTimeoutMs,
          );
        } catch (cause) {
          throw coerceManagementError(cause);
        }
        const reply = parseSwitchConfigReply(parsed);
        if (reply.status !== 'success') {
          // The plugin handler returns `{status:"error",message:"..."}`
          // for "no config file specified" / "config file does not
          // exist". The string body is informational only — we map
          // every error reply onto `http_error` because the surface
          // returned 200, the request was authenticated, but the
          // upstream side refused the operation. The redaction sieve
          // strips any captured secret values from the message even
          // though the lua handler doesn't echo any.
          throw sievedError(
            'http_error',
            reply.message !== null
              ? `POST switch_config: ${reply.message}`
              : 'POST switch_config: refused',
          );
        }
      } catch (cause) {
        const err = coerceManagementError(cause);
        recordCollectorFailure(now(), err.code);
        return {
          ok: false,
          startPath,
          targetPath,
          finalPath: null,
          error: err,
        };
      }

      // -----------------------------------------------------------------
      // 3) Verify loop.
      //
      // - At most VERIFY_MAX_ITERATIONS (3) iterations.
      // - Time-bounded by `verifyWindowMs` (the trailing
      //   `requestTimeoutMs` of the in-flight calls is implicit in
      //   each iteration's sub-timeout, so the total elapsed wall
      //   time stays within `verifyWindowMs + requestTimeoutMs`).
      // - Each iteration runs the `uci.get` re-read and (when not yet
      //   observed) the controller liveness probe in parallel with a
      //   2 s sub-timeout each (VERIFY_SUBCALL_TIMEOUT_MS).
      // - `apiOk` short-circuits to `true` once observed (the
      //   controller may flap during reload — design.md
      //   §`openclash.management.service.ts` §Verify).
      // - Returns ok iff at least one iteration sees BOTH `pathOk`
      //   (re-read returned exactly `targetPath`) AND `apiOkSeen`.
      // -----------------------------------------------------------------
      const loopStart = now();
      let lastReadEnd = 0;
      let apiOkSeen = false;
      let finalPath: string | null = null;

      for (let iteration = 0; iteration < VERIFY_MAX_ITERATIONS; iteration++) {
        // Bail out before issuing the next read if the verify window
        // has already expired. A 0/negative window is treated as
        // "do not poll" — the loop falls through to `verify_timeout`.
        if (now() - loopStart >= verifyWindowMs) {
          break;
        }

        // Enforce the ≥ 1000 ms gap between consecutive reads
        // (Requirement 15.4). Iteration 1 has `lastReadEnd === 0` so
        // `gap` is negative and we skip the sleep entirely.
        if (iteration > 0) {
          const gap = lastReadEnd + VERIFY_MIN_GAP_MS - now();
          if (gap > 0) {
            await sleep(gap);
          }

          // Re-check the window after the sleep — the timer may have
          // pushed us past the budget while we were waiting.
          if (now() - loopStart >= verifyWindowMs) {
            break;
          }
        }

        // Issue the re-read and (if needed) the liveness probe in
        // parallel. Either may reject; the failures are swallowed
        // into local booleans because the verify loop's contract is
        // observational — it returns `verify_timeout` only when the
        // budget is exhausted, never an inner read's specific error.
        const readPromise = readActiveConfigPathOnce(VERIFY_SUBCALL_TIMEOUT_MS);
        const apiPromise: Promise<boolean> = apiOkSeen
          ? Promise.resolve(true)
          : controllerHealthcheck({ timeoutMs: VERIFY_SUBCALL_TIMEOUT_MS }).catch(
              () => false,
            );

        const [readSettled, apiSettled] = await Promise.allSettled([
          readPromise,
          apiPromise,
        ]);

        let pathOk = false;
        if (readSettled.status === 'fulfilled') {
          finalPath = readSettled.value;
          pathOk = readSettled.value === targetPath;
        }
        // On a rejected read we leave `finalPath` at its previous
        // value (which may still be `null`) and `pathOk = false`.

        if (apiSettled.status === 'fulfilled' && apiSettled.value === true) {
          apiOkSeen = true;
        }
        // A rejected `apiPromise` cannot happen because we attached
        // `.catch(() => false)`, but `Promise.allSettled` widens to
        // `PromiseSettledResult` for completeness.

        lastReadEnd = now();

        if (pathOk && apiOkSeen) {
          recordCollectorSuccess(lastReadEnd);
          return {
            ok: true,
            startPath,
            targetPath,
            finalPath,
          };
        }
      }

      // -----------------------------------------------------------------
      // 4) Loop exit without a confirmed flip.
      //
      // The closed-set code is `verify_timeout`: Requirement 15.5
      // explicitly groups "3 reads exhausted" and "window elapsed"
      // under the same code, so we do not need to distinguish them
      // in the audit row.
      // -----------------------------------------------------------------
      const err = sievedError(
        'verify_timeout',
        finalPath === null
          ? `verify timed out after ${VERIFY_MAX_ITERATIONS} reads (no path observed)`
          : `verify timed out: last observed path '${finalPath}' != target`,
      );
      recordCollectorFailure(now(), err.code);
      return {
        ok: false,
        startPath,
        targetPath,
        finalPath,
        error: err,
      };
    },

    invalidateSession(): void {
      // Idempotent: clearing an already-empty cache is a no-op. The
      // skeleton's `null` re-assignment is the canonical post-
      // condition the rest of the codebase will assume — tasks 8.3,
      // 8.4, and 10.5 all rely on it.
      cachedSessionCookie = null;
    },
  };
}
