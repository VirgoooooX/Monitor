// Switch-with-verify orchestrator for OpenClash policy groups.
//
// References:
//   - design.md §Switch Node With Verification (algorithmic spec)
//   - design.md §Property 7 (switch verify never silently lies)
//   - design.md §Property 8 (switch never retries on failure)
//   - PLAN.md §切换一致性 / §switchVerifyDelayMs
//
// Why this lives in its own file:
//
// - `openclash.service.ts` is the raw HTTP client. It already knows how
//   to issue `PUT /proxies/{group}` and `GET /proxies`, but it must
//   stay free of database writes so it can be exercised under unit
//   tests with no SQLite at hand.
// - The verify dance is a *protocol* on top of that client: PUT, sleep,
//   GET, compare, write a snapshot row. Keeping it here means the IPC
//   handler (task 3.11) wires up exactly one service object and the
//   property tests for §Property 7 / §Property 8 can drive the protocol
//   without touching `fetch`.
//
// Determinism contract:
//
// `switchNode` performs **at most one** `PUT /proxies/{group}` call per
// invocation, regardless of any failure path. This is a hard invariant
// (design.md §Property 8): the UI is responsible for retry — never the
// service. Every early return below points back at the same PUT with
// no loop.
//
// State transitions written to `openclash_snapshots` (single insert per
// invocation):
//
//   PUT 401            → status='auth_error',     apiOk=false
//   PUT non-2xx / err  → status='http_error',     apiOk=false
//   GET fails / shape  → status='verify_timeout', apiOk=false
//   GET shows ≠ node   → status='verify_mismatch',apiOk=true (node_name=actual)
//   GET shows = node   → status='ok',             apiOk=true (node_name=node)

import {
  AuthError,
  HttpError,
  NetworkError,
  ParseError,
  type OpenClashClient,
} from './openclash.service';
import type { OpenClashSnapshotsRepository } from '../store/repositories';
import type { ProxyEntry, SwitchErrorCode, SwitchNodeResult } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Per-request timeout for both the PUT and the verifying GET. Matches
 * design.md §Switch Node With Verification ("timeout = 5000ms" on both
 * the PUT and the GET).
 */
const SWITCH_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Fallback for `getSwitchVerifyDelayMs()` when the supplied getter
 * returns a non-finite or negative value (defensive — schemas at the
 * IPC boundary already enforce 0..10_000 ms).
 */
const DEFAULT_SWITCH_VERIFY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface SwitchNodeServiceDeps {
  /**
   * The HTTP client used for both the PUT and the verifying GET. The
   * service does not own its lifecycle — `app.ts` constructs one
   * client and shares it across the OpenClash collector, the IPC
   * layer, and this service.
   */
  client: OpenClashClient;
  /** Repository used to persist the single per-invocation snapshot. */
  snapshotsRepo: OpenClashSnapshotsRepository;
  /**
   * Live read of `AppSettings.switchVerifyDelayMs`. A getter is used
   * (instead of a captured number) so user edits in Settings take
   * effect on the very next `switchNode` call without reconstructing
   * the service.
   */
  getSwitchVerifyDelayMs: () => number;
  /** Override `Date.now` for deterministic tests. */
  now?: () => number;
  /** Override the verify-delay sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SwitchNodeService {
  /**
   * Switch the given group to the given node and verify the change
   * landed on the controller. Performs **no retries**: on any failure
   * a single snapshot row is written and a `{ ok: false, … }` result
   * is returned. The caller (UI) decides whether to retry.
   *
   * Throws `TypeError` when `group` or `node` is empty after trimming
   * — the IPC schema layer normally rejects such payloads first; this
   * guard exists so direct callers cannot bypass the contract.
   */
  switchNode(group: string, node: string): Promise<SwitchNodeResult>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Default sleep using `setTimeout`. Resolves after `ms` milliseconds. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Coerce the live setting into a non-negative integer. Defensive-only
 * because the IPC validation layer enforces `0..10_000`.
 */
function clampDelayMs(getter: () => number): number {
  const raw = getter();
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_SWITCH_VERIFY_DELAY_MS;
  }
  return Math.floor(raw);
}

/**
 * Extract the message of a thrown value without leaking secrets. The
 * `OpenClashClient` is careful to redact secrets from its error
 * messages already, but we still avoid `JSON.stringify(err)` here in
 * case a future error subclass picks up an embedded auth header.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  return 'unknown error';
}

/**
 * Read the current selection out of a `/proxies` response. Returns
 * `null` when the group is missing from the response (e.g. the user
 * removed it between the PUT and the GET) or when no `now` / `current`
 * field is set.
 */
function readActualCurrent(
  proxiesByName: Record<string, ProxyEntry>,
  group: string,
): string | null {
  const entry = proxiesByName[group];
  if (entry === undefined) {
    return null;
  }
  if (typeof entry.now === 'string' && entry.now.length > 0) {
    return entry.now;
  }
  if (typeof entry.current === 'string' && entry.current.length > 0) {
    return entry.current;
  }
  return null;
}

/**
 * Build a `{ ok: false, … }` result with the typed error code. Kept
 * private so every failure path goes through one constructor and the
 * shape stays consistent (the discriminated union in `SwitchNodeResult`
 * is checked by the type system, but `actualCurrent: null` is easy to
 * forget).
 */
function buildFailure(
  code: SwitchErrorCode,
  message: string,
  actualCurrent: string | null,
): SwitchNodeResult {
  return {
    ok: false,
    error: { code, message },
    actualCurrent,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link SwitchNodeService}. The returned object is stateless
 * beyond its captured deps — `switchNode` may be called concurrently
 * from multiple IPC frames, but the design guarantees the renderer
 * disables the UI affordance during a switch so concurrent calls are
 * not expected. Even if they did overlap, each invocation issues a
 * single PUT and writes a single snapshot, so the worst-case behaviour
 * is two unrelated audit rows — never a retry.
 */
export function createSwitchNodeService(
  deps: SwitchNodeServiceDeps,
): SwitchNodeService {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const { client, snapshotsRepo, getSwitchVerifyDelayMs } = deps;

  return {
    async switchNode(group, node): Promise<SwitchNodeResult> {
      // Defensive contract guard. The IPC schema (task 3.11) already
      // rejects empty / whitespace-only inputs, so this should never
      // fire in production. Throwing rather than returning `ok:false`
      // makes the violation loud at the call site.
      if (typeof group !== 'string' || typeof node !== 'string') {
        throw new TypeError('switchNode: group and node must be strings');
      }
      const trimmedGroup = group.trim();
      const trimmedNode = node.trim();
      if (trimmedGroup.length === 0 || trimmedNode.length === 0) {
        throw new TypeError(
          'switchNode: group and node must be non-empty after trimming',
        );
      }

      // ------------------------------------------------------------------
      // Step 1 — PUT /proxies/{group} { name: node }
      // ------------------------------------------------------------------
      try {
        await client.putGroupSelection(trimmedGroup, trimmedNode, {
          timeoutMs: SWITCH_REQUEST_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof AuthError) {
          snapshotsRepo.insert({
            timestamp: now(),
            apiOk: false,
            mode: null,
            groupName: trimmedGroup,
            nodeName: trimmedNode,
            status: 'auth_error',
          });
          return buildFailure('auth_error', describeError(err), null);
        }
        if (
          err instanceof HttpError ||
          err instanceof NetworkError ||
          err instanceof ParseError
        ) {
          snapshotsRepo.insert({
            timestamp: now(),
            apiOk: false,
            mode: null,
            groupName: trimmedGroup,
            nodeName: trimmedNode,
            status: 'http_error',
          });
          return buildFailure('http_error', describeError(err), null);
        }
        // Unknown throwable — fall through to the http_error bucket so
        // the caller still sees a structured failure (and the audit
        // trail still gets a row). Rethrowing here would leak a raw
        // exception across the IPC boundary.
        snapshotsRepo.insert({
          timestamp: now(),
          apiOk: false,
          mode: null,
          groupName: trimmedGroup,
          nodeName: trimmedNode,
          status: 'http_error',
        });
        return buildFailure('http_error', describeError(err), null);
      }

      // ------------------------------------------------------------------
      // Step 2 — wait switchVerifyDelayMs (default 1000)
      // ------------------------------------------------------------------
      const delayMs = clampDelayMs(getSwitchVerifyDelayMs);
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      // ------------------------------------------------------------------
      // Step 3 — GET /proxies (single attempt; no retry per Property 8)
      // ------------------------------------------------------------------
      let proxiesByName: Record<string, ProxyEntry>;
      try {
        const proxies = await client.getProxies({
          timeoutMs: SWITCH_REQUEST_TIMEOUT_MS,
        });
        proxiesByName = proxies.proxies;
      } catch (err) {
        snapshotsRepo.insert({
          timestamp: now(),
          apiOk: false,
          mode: null,
          groupName: trimmedGroup,
          nodeName: trimmedNode,
          status: 'verify_timeout',
        });
        return buildFailure('verify_timeout', describeError(err), null);
      }

      // ------------------------------------------------------------------
      // Step 4 — compare current selection
      // ------------------------------------------------------------------
      const actual = readActualCurrent(proxiesByName, trimmedGroup);
      if (actual === null) {
        // Group disappeared between PUT and GET, or the entry has no
        // selection field. Either way we cannot prove the switch
        // landed, which is exactly the failure §Property 7 forbids us
        // from silently swallowing — surface as a verify_timeout.
        snapshotsRepo.insert({
          timestamp: now(),
          apiOk: false,
          mode: null,
          groupName: trimmedGroup,
          nodeName: trimmedNode,
          status: 'verify_timeout',
        });
        return buildFailure(
          'verify_timeout',
          `group "${trimmedGroup}" missing or has no current selection in /proxies`,
          null,
        );
      }

      if (actual === trimmedNode) {
        const verifiedAt = now();
        snapshotsRepo.insert({
          timestamp: verifiedAt,
          apiOk: true,
          mode: null,
          groupName: trimmedGroup,
          nodeName: trimmedNode,
          status: 'ok',
        });
        return { ok: true, newCurrent: trimmedNode, verifiedAt };
      }

      // Mismatch — record the *actual* selection so the audit row
      // reflects what the controller is doing, not what we asked for.
      snapshotsRepo.insert({
        timestamp: now(),
        apiOk: true,
        mode: null,
        groupName: trimmedGroup,
        nodeName: actual,
        status: 'verify_mismatch',
      });
      return buildFailure(
        'verify_mismatch',
        `group "${trimmedGroup}" still selects "${actual}" instead of "${trimmedNode}"`,
        actual,
      );
    },
  };
}
