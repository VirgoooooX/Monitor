// Global switch mutex for OpenClash Config_Switch and per-group Node_Switch.
//
// References:
//   - design.md §`switch.lock.ts` — Global Switch Mutex (interface contract)
//   - design.md §Property 3 (Exclusive switch invariant) — lock half
//   - design.md §Property 7 (Watchdog force-release at 2 × verify window)
//   - requirements.md Requirement 9.1..9.5
//
// Why this lives in its own file:
//
// - The IPC orchestrator (task 10.4) needs a single source of truth for
//   "is some switch in flight?" so `getNetworkQuickActions` can render
//   `switchInProgress` without racing the orchestrator. A standalone
//   pure-JS module — no DB writes, no `fetch`, no Electron imports —
//   keeps the property tests simple and deterministic.
// - The acquisition rules straddle two callers (`switchNode` and the new
//   `switchOpenClashConfig` flow). Folding the logic into either of
//   them would couple the two flows; promoting it to its own primitive
//   keeps each caller blissfully unaware of the other.
//
// Determinism contract:
//
// - `acquire` is the only function that may construct a `SwitchLockToken`.
//   Tokens carry a UUIDv4 `id` so callers cannot forge them (the IPC
//   orchestrator uses `id` equality to release the right token).
// - `acquire` is synchronous: the mutex check, token creation, and
//   watchdog scheduling all happen before the call returns. Callers can
//   therefore reason about "did I get the lock?" without awaiting any
//   promise — this is what lets the IPC handler return
//   `switch_in_progress` immediately on rejection (Requirement 9.2).
// - `release` is idempotent. Releasing an unknown token (already
//   released, force-released, or never issued) is a no-op. The
//   orchestrator can therefore wrap its `release(token)` call in a
//   `finally` block without worrying about double-release on the
//   force-release path.
// - The watchdog is the only path that fires `onForceRelease`. The
//   normal `release` path never invokes it (the orchestrator already
//   knows the lock was released because it called `release` itself).
// - Time and the timer scheduler are injectable. `now` is a getter so
//   tests can advance a virtual clock; the watchdog uses Node's
//   `setTimeout` directly because vitest's `vi.useFakeTimers()` already
//   provides deterministic control over real timers — there is no
//   need for a third injection point.

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public surface — types
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing what kind of switch a token guards.
 *
 * - `{ type: 'config' }` is **globally exclusive**: while a config token
 *   is alive, no further acquire succeeds (regardless of kind).
 * - `{ type: 'node', group }` is **per-group exclusive**: at most one
 *   alive token per `group`. Tokens for different groups can coexist.
 *   Holding any node token blocks a config acquire — the config flow
 *   needs the whole controller, not just one group.
 */
export type SwitchKind =
  | { readonly type: 'config' }
  | { readonly type: 'node'; readonly group: string };

/**
 * Opaque token returned by `acquire`. Callers must treat the contents
 * as read-only and pass the same object back to `release`.
 *
 * Fields:
 * - `id` — UUIDv4, unique per acquired token. Used by `release` to
 *   identify which slot to free; using the token reference alone would
 *   be fine in-process, but `id` survives JSON round-trips for any
 *   future audit / IPC transport.
 * - `kind` — captured at acquire time; the lock does not allow a
 *   token to "change kind".
 * - `acquiredAt` / `deadlineAt` — both in `Date.now()` epoch ms. The
 *   watchdog fires at `deadlineAt = acquiredAt + ttlMs` if `release`
 *   has not been called by then.
 */
export interface SwitchLockToken {
  readonly id: string;
  readonly kind: SwitchKind;
  readonly acquiredAt: number;
  readonly deadlineAt: number;
}

/**
 * Snapshot of the lock's internal state. Pure read — does not mutate
 * the lock or the watchdogs. Useful for the IPC handler that builds
 * `NetworkQuickActions.switchInProgress` and for property tests.
 */
export interface SwitchLockSnapshot {
  /** The currently-held config token, or `null` when none is alive. */
  config: SwitchLockToken | null;
  /** Currently-held node tokens, one per active group. Iteration order is unspecified. */
  nodes: SwitchLockToken[];
}

export interface SwitchLock {
  /**
   * Try to acquire the lock. Returns `null` when the request must be
   * rejected with `switch_in_progress`.
   *
   * Acquisition rules (matches design.md §`switch.lock.ts`):
   *   - If a `'config'` lock is held: every new acquire returns `null`.
   *   - If only `'node:G'` locks are held:
   *       - `acquire('config')` returns `null` (config needs the whole controller)
   *       - `acquire('node:G')`  returns `null` (same-group reentry blocked)
   *       - `acquire('node:H')`  returns a token (different group)
   *
   * `ttlMs` must be a positive finite number. The watchdog is scheduled
   * synchronously before this function returns.
   */
  acquire(kind: SwitchKind, ttlMs: number): SwitchLockToken | null;

  /**
   * Release a token. Idempotent: releasing an unknown token (already
   * released or never issued by this lock) is a no-op. Cancels the
   * pending watchdog if the token is currently held.
   */
  release(token: SwitchLockToken): void;

  /**
   * Pure read of the lock state. The returned arrays / objects are
   * fresh copies — mutating them does not affect the lock.
   */
  snapshot(): SwitchLockSnapshot;
}

export interface SwitchLockDeps {
  /**
   * Override `Date.now`. Tests inject a virtual clock; production code
   * leaves this unset.
   */
  now?: () => number;
  /**
   * Side-channel for the watchdog. Invoked exactly once with the
   * force-released token when its `ttlMs` elapses without a `release`
   * call. Never invoked for normal releases.
   *
   * Exceptions thrown by the callback are swallowed so a misbehaving
   * caller cannot crash the lock's internal scheduler.
   */
  onForceRelease?: (token: SwitchLockToken) => void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Per-token bookkeeping: the public token plus the timer handle that
 * implements the watchdog. The handle is kept private so callers cannot
 * cancel another caller's watchdog.
 */
interface ActiveToken {
  readonly token: SwitchLockToken;
  /**
   * The pending `setTimeout` handle, or `null` once the watchdog has
   * fired or been cancelled. Tracking the latter explicitly lets
   * `release` distinguish "still alive, cancel the timer" from "watchdog
   * already fired, do nothing".
   */
  timer: ReturnType<typeof setTimeout> | null;
}

function validateTtl(ttlMs: number): void {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError(
      'switch.lock.acquire: ttlMs must be a positive finite number',
    );
  }
}

function validateKind(kind: SwitchKind): void {
  if (kind === null || typeof kind !== 'object') {
    throw new TypeError('switch.lock.acquire: kind must be an object');
  }
  if (kind.type === 'config') {
    return;
  }
  if (kind.type === 'node') {
    if (typeof kind.group !== 'string' || kind.group.length === 0) {
      throw new TypeError(
        "switch.lock.acquire: node kind requires a non-empty 'group' string",
      );
    }
    return;
  }
  throw new TypeError(
    `switch.lock.acquire: unknown kind type ${JSON.stringify(
      (kind as { type?: unknown }).type,
    )}`,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link SwitchLock}. The returned object owns its own internal
 * state — independent locks do not share tokens or watchdogs, which
 * lets tests construct fresh instances per case without worrying about
 * cross-contamination.
 */
export function createSwitchLock(deps?: SwitchLockDeps): SwitchLock {
  const now = deps?.now ?? Date.now;
  const onForceRelease = deps?.onForceRelease;

  /**
   * The currently-held config token, or `null`. There is at most one
   * config token alive at any time (Requirement 9.2 invariant).
   */
  let configHolder: ActiveToken | null = null;

  /**
   * Currently-held node tokens, keyed by group. Per-group exclusivity
   * follows from `Map.set` overwriting the previous entry — but we
   * never reach the overwrite path because `acquire` rejects a same-
   * group reentry up front. Using a `Map` keeps the snapshot iteration
   * order stable (insertion order), which simplifies test assertions.
   */
  const nodeHolders = new Map<string, ActiveToken>();

  /**
   * Drop bookkeeping for `id`, regardless of which collection it lives
   * in. Returns the popped record or `null` if the id was unknown.
   * Does NOT cancel the timer — the caller is responsible for that
   * because the cancellation semantics differ between `release` (cancel)
   * and the watchdog firing (already fired).
   */
  function popById(id: string): ActiveToken | null {
    if (configHolder !== null && configHolder.token.id === id) {
      const popped = configHolder;
      configHolder = null;
      return popped;
    }
    for (const [group, active] of nodeHolders) {
      if (active.token.id === id) {
        nodeHolders.delete(group);
        return active;
      }
    }
    return null;
  }

  /**
   * Watchdog callback. Runs when `ttlMs` elapses without a `release`
   * call. The token may already have been released by the legitimate
   * caller — `popById` handles that case as a no-op.
   *
   * Exactly-once invocation of `onForceRelease` is guaranteed by:
   *   1. `popById` returning `null` if the token was already released
   *      (so we exit early before invoking the callback);
   *   2. The timer handle being cleared synchronously inside `release`
   *      before any other caller can observe the lock as free, which
   *      means the watchdog cannot have been already-fired-but-still-
   *      scheduled — `setTimeout`'s contract guarantees the callback
   *      runs at most once per timer.
   */
  function onWatchdogFire(id: string): void {
    const popped = popById(id);
    if (popped === null) {
      // The legitimate caller already released the token between the
      // timer firing and this callback running (e.g. with fake timers
      // that fire synchronously, this branch is unreachable). The
      // contract still says "exactly once" — we honour it by NOT
      // invoking the callback in this case because the token is no
      // longer held by anyone.
      return;
    }
    // Mark the timer as already-fired so a follow-up `release` from a
    // confused caller does not try to clear a stale handle.
    popped.timer = null;
    if (onForceRelease !== undefined) {
      try {
        onForceRelease(popped.token);
      } catch {
        // Swallow — see SwitchLockDeps.onForceRelease docstring.
      }
    }
  }

  return {
    acquire(kind: SwitchKind, ttlMs: number): SwitchLockToken | null {
      validateKind(kind);
      validateTtl(ttlMs);

      // Rule 1: a held config lock blocks every kind of acquire.
      if (configHolder !== null) {
        return null;
      }
      if (kind.type === 'config') {
        // Rule 2: a config acquire also needs the controller free of
        // any node lock — config_switch reloads the entire kernel.
        if (nodeHolders.size > 0) {
          return null;
        }
      } else {
        // Rule 3: per-group exclusivity for node acquires.
        if (nodeHolders.has(kind.group)) {
          return null;
        }
      }

      const acquiredAt = now();
      const deadlineAt = acquiredAt + ttlMs;
      // Freeze a copy of `kind` so callers cannot mutate it after the
      // fact (e.g. by reassigning `kind.group` to bypass per-group
      // exclusivity on the next acquire).
      const frozenKind: SwitchKind =
        kind.type === 'config'
          ? Object.freeze({ type: 'config' as const })
          : Object.freeze({ type: 'node' as const, group: kind.group });
      const token: SwitchLockToken = Object.freeze({
        id: randomUUID(),
        kind: frozenKind,
        acquiredAt,
        deadlineAt,
      });

      // Schedule the watchdog. We capture `token.id` (not the token
      // object) so the closure does not pin an alternate reference
      // that survives `popById`.
      const tokenId = token.id;
      const timer = setTimeout(() => {
        onWatchdogFire(tokenId);
      }, ttlMs);
      // `unref` on Node so the watchdog does not keep the event loop
      // alive on its own — the orchestrator's release-on-finally path
      // is the normal exit, and a force-release on shutdown is fine.
      const t = timer as { unref?: () => void };
      if (typeof t.unref === 'function') {
        t.unref();
      }

      const active: ActiveToken = { token, timer };
      if (kind.type === 'config') {
        configHolder = active;
      } else {
        nodeHolders.set(kind.group, active);
      }
      return token;
    },

    release(token: SwitchLockToken): void {
      // Defensive shape check — a renderer-controlled IPC payload
      // could arrive here, and the rest of the function assumes
      // `token.id` is a string.
      if (
        token === null ||
        typeof token !== 'object' ||
        typeof token.id !== 'string'
      ) {
        return;
      }
      const popped = popById(token.id);
      if (popped === null) {
        // Unknown / already-released token — no-op (idempotency).
        return;
      }
      if (popped.timer !== null) {
        clearTimeout(popped.timer);
        popped.timer = null;
      }
    },

    snapshot(): SwitchLockSnapshot {
      const nodes: SwitchLockToken[] = [];
      for (const active of nodeHolders.values()) {
        nodes.push(active.token);
      }
      return {
        config: configHolder !== null ? configHolder.token : null,
        nodes,
      };
    },
  };
}
