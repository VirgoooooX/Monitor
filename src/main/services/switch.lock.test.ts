// Feature: network-quick-actions, Property 3 (lock half)
// Feature: network-quick-actions, Property 7
//
// Property tests for `createSwitchLock`:
//   - Property 3 (lock half) — exclusive switch invariant across arbitrary
//     `acquire` / `release` traces (this file's IPC-side coverage; the
//     UI-side coverage of Property 3 lives in QuickNodeCard.test.tsx).
//   - Property 7 — watchdog force-release at `ttlMs = 2 × W`.
//
// References:
//   - design.md §`switch.lock.ts` — Global Switch Mutex (interface contract)
//   - design.md §Property 3 (Exclusive switch invariant — UI and IPC agree)
//   - design.md §Property 7 (Watchdog force-release at 2 × verify window)
//   - requirements.md Requirement 9.1, 9.2, 9.3, 9.5

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { createSwitchLock, type SwitchKind, type SwitchLockToken } from './switch.lock';

// Arbitrary W ∈ [1000, 30000] — matches the spec's
// `configSwitchVerifyWindowMs` allowable range.
const verifyWindowArb = fc.integer({ min: 1_000, max: 30_000 });

// Arbitrary kind: `'config'` or a per-group `'node'` with a non-empty
// printable label. The lock contract treats these symmetrically for
// the watchdog path, so we exercise both.
const kindArb: fc.Arbitrary<SwitchKind> = fc.oneof(
  fc.constant<SwitchKind>({ type: 'config' }),
  fc
    .string({ minLength: 1, maxLength: 16 })
    // Reject groups that collapse to empty after JS string parsing —
    // the lock validates `group` is non-empty, but fast-check can
    // still emit strings containing only NUL or surrogate halves.
    .filter((s) => s.length > 0)
    .map<SwitchKind>((group) => ({ type: 'node', group })),
);

describe('createSwitchLock — Property 3 (lock half): exclusive switch invariant', () => {
  beforeEach(() => {
    // Fake timers keep every `setTimeout(release, ttlMs)` scheduled by
    // `acquire` from firing during the trace. We never advance the
    // clock here (Property 3 is about arbitration, not the watchdog —
    // Property 7 below covers the watchdog path), and the per-run
    // cleanup at the bottom of the property releases every token so
    // pending timers do not leak into the next run.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maintains four invariants over arbitrary acquire/release traces', () => {
    // Each step in the trace either tries to acquire a fresh token of
    // a generated kind, or releases an arbitrary token from the
    // currently-alive set. `sel` is wrapped modulo the alive count so
    // fast-check can shrink toward simple counter-examples without
    // having to know the exact index.
    type Op =
      | { tag: 'acquire'; kind: SwitchKind }
      | { tag: 'release'; sel: number };

    const opArb: fc.Arbitrary<Op> = fc.oneof(
      kindArb.map<Op>((kind) => ({ tag: 'acquire', kind })),
      fc.nat({ max: 31 }).map<Op>((sel) => ({ tag: 'release', sel })),
    );

    // ttl far larger than any trace: the watchdog never fires because
    // we never advance the fake clock. This isolates Property 3 from
    // Property 7's force-release dynamics.
    const TTL_MS = 1_000_000;

    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 64 }), (ops) => {
        // Reset between runs: drop any pending timer scheduled by a
        // prior trace and anchor the virtual clock so `acquiredAt` is
        // reproducible.
        vi.clearAllTimers();
        vi.setSystemTime(0);

        const lock = createSwitchLock({ now: () => Date.now() });
        // Mirror of the lock's alive set, used to drive `release` ops
        // and to assert invariants without re-querying `snapshot` for
        // every check.
        const aliveTokens: SwitchLockToken[] = [];

        for (const op of ops) {
          if (op.tag === 'acquire') {
            // Compute the contractually-correct outcome from the
            // snapshot BEFORE the call, so we can assert that the
            // lock's decision matches the four invariants.
            const before = lock.snapshot();
            const blockedByConfig = before.config !== null;
            const blockedByNodes =
              op.kind.type === 'config'
                ? before.nodes.length > 0
                : before.nodes.some(
                    (t) =>
                      t.kind.type === 'node' && t.kind.group === op.kind.group,
                  );
            const wouldBlock = blockedByConfig || blockedByNodes;

            const token = lock.acquire(op.kind, TTL_MS);

            if (wouldBlock) {
              // Invariant (4) "'config' blocks all others" and the
              // per-group exclusion together imply: any acquire that
              // collides with the alive set MUST return null.
              expect(token).toBeNull();
            } else {
              // Conversely, when nothing collides the acquire MUST
              // succeed — this is what makes Invariant (3) "cross-
              // group nodes can coexist" observable: a fresh group
              // acquire succeeds even while other group tokens live.
              expect(token).not.toBeNull();
              if (token !== null) {
                aliveTokens.push(token);
              }
            }
          } else {
            // Release path: pick any currently-alive token (no-op
            // when the alive set is empty so the trace generator can
            // shrink without contortions).
            if (aliveTokens.length > 0) {
              const idx = op.sel % aliveTokens.length;
              const [tok] = aliveTokens.splice(idx, 1);
              lock.release(tok);
            }
          }

          // ---------- Invariants checked after EVERY step ----------
          const snap = lock.snapshot();

          // (1) At most one `'config'` token alive — `snap.config` is
          // typed as a single value, but we also assert it really is
          // a config-kind token (the lock must not file a node token
          // there by mistake).
          if (snap.config !== null) {
            expect(snap.config.kind.type).toBe('config');
          }

          // (2) Per-group at most one `'node:G'` token alive: the set
          // of groups in `snap.nodes` is unique and every entry is a
          // node-kind token.
          const groups: string[] = [];
          for (const t of snap.nodes) {
            expect(t.kind.type).toBe('node');
            if (t.kind.type === 'node') groups.push(t.kind.group);
          }
          expect(new Set(groups).size).toBe(groups.length);

          // (3) Cross-group nodes can coexist: this is observed in the
          // acquire branch above whenever a new group token is granted
          // while a prior different-group token is still alive. The
          // accumulating `snap.nodes.length` over such steps confirms
          // the lock does not artificially serialize different groups.
          // (No standalone assertion needed beyond Invariants 1, 2, 4
          // plus the acquire-decision check.)

          // (4) `'config'` blocks all others: if a config token is
          // alive, the node set MUST be empty. (Symmetrically the
          // acquire-decision check above already prevents acquiring a
          // node while config is held.)
          if (snap.config !== null) {
            expect(snap.nodes).toEqual([]);
          }

          // Sanity coupling between the model mirror and the lock:
          // the count of alive tokens must agree.
          const lockAliveCount =
            (snap.config !== null ? 1 : 0) + snap.nodes.length;
          expect(lockAliveCount).toBe(aliveTokens.length);
        }

        // Drain remaining tokens so their watchdog timers are
        // cancelled before the next fast-check run.
        for (const t of aliveTokens) {
          lock.release(t);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('createSwitchLock — Property 7: watchdog force-release at ttlMs', () => {
  beforeEach(() => {
    // Use fake timers so the watchdog's `setTimeout(release, ttlMs)`
    // is driven by `vi.advanceTimersByTime` instead of wall-clock.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('force-releases once and frees the lock when ttlMs elapses without release', () => {
    fc.assert(
      fc.property(verifyWindowArb, kindArb, (W, kind) => {
        // Reset fake-timer state between fast-check runs so a stray
        // pending timer from one run cannot bleed into the next.
        vi.clearAllTimers();
        // Anchor the virtual clock so `acquiredAt` is reproducible
        // across runs and unaffected by host time.
        vi.setSystemTime(0);

        const released: SwitchLockToken[] = [];
        const lock = createSwitchLock({
          // Inject `now` as a getter so the lock observes the same
          // virtual clock that `vi.advanceTimersByTime` advances.
          now: () => Date.now(),
          onForceRelease: (token) => {
            released.push(token);
          },
        });

        const ttlMs = 2 * W;
        const token = lock.acquire(kind, ttlMs);
        // Acquire on a fresh lock must succeed regardless of kind.
        expect(token).not.toBeNull();
        if (token === null) return;

        // Sanity: deadline matches the contract `acquiredAt + ttlMs`.
        expect(token.deadlineAt - token.acquiredAt).toBe(ttlMs);

        // Advance past the deadline by 1ms; the watchdog must fire
        // exactly once (Property 7: total advance = 2W + 1 ms past
        // acquiredAt = 0).
        vi.advanceTimersByTime(ttlMs + 1);

        // Watchdog invoked exactly once with the same token.
        expect(released).toHaveLength(1);
        expect(released[0]).toBe(token);

        // Lock is free: a fresh acquire of the SAME kind succeeds.
        const refreshed = lock.acquire(kind, ttlMs);
        expect(refreshed).not.toBeNull();
        // And the refreshed token is a distinct object with a new id.
        if (refreshed !== null) {
          expect(refreshed.id).not.toBe(token.id);
        }

        // Snapshot reflects exactly one held token (the refreshed one)
        // — proving the original was fully evicted from the lock's
        // bookkeeping by the watchdog.
        const snap = lock.snapshot();
        if (kind.type === 'config') {
          expect(snap.config).not.toBeNull();
          expect(snap.nodes).toEqual([]);
        } else {
          expect(snap.config).toBeNull();
          expect(snap.nodes).toHaveLength(1);
        }

        // Clean up the refreshed token's pending watchdog so it does
        // not leak into the next fast-check run.
        if (refreshed !== null) {
          lock.release(refreshed);
        }
      }),
      { numRuns: 100 },
    );
  });
});
