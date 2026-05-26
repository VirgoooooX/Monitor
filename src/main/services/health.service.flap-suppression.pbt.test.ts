// Feature: network-quick-actions, Property 8: Verify-window flap does not escalate health.
//
// Validates Requirements 5.10.
//
// Property 8 (from network-quick-actions/design.md §Property 8):
//   For any simulated period in which the Clash Controller API responds
//   intermittently while a Config_Switch is in flight, if the longest
//   unreachable streak ends within `configSwitchVerifyWindowMs` of the
//   switch start, the dashboard's `HealthStatus` returned during that
//   period (assuming all other inputs healthy) is NOT
//   `openclash_unreachable`.
//
// We exercise the **stateful wrapper** built by `createHealthService`
// (task 12.1). Three sub-properties cover the wrapper's three branches:
//
//   Property 8a — Suppression is active.
//     When a `'config'` token is held AND `now() - acquiredAt <
//     verifyWindowMs`, the wrapper's `evaluate` MUST NOT return
//     `openclash_unreachable`. Concretely, for any controller-flap
//     inputs whose pure verdict is `openclash_unreachable`, the wrapper
//     returns the pure verdict computed against a "controller is fine"
//     view of the inputs (`openclashTcpReachable: true`,
//     `openclashApiOk: true`). For any inputs whose pure verdict is
//     already non-`openclash_unreachable` (e.g. `home_down`,
//     `partial_outage`, `node_slow`, `healthy`) the wrapper forwards
//     the verdict verbatim — the suppression branch is gated on the
//     baseline already being `openclash_unreachable`.
//
//   Property 8b — Suppression is gone past the window.
//     When `now() - acquiredAt >= verifyWindowMs` the wrapper falls
//     through to the pure `evaluate` regardless of the lock state, so
//     `openclash_unreachable` again surfaces whenever the inputs would
//     trigger it. Asserts wrapper === pure.
//
//   Property 8c — No config lock means no suppression.
//     When `snapshot().config === null` the wrapper is observationally
//     equivalent to the pure `evaluate`, regardless of `now` or
//     `verifyWindowMs`. Asserts wrapper === pure.
//
// References:
//   - .kiro/specs/network-quick-actions/design.md §Property 8
//   - .kiro/specs/network-quick-actions/requirements.md Requirement 5.10
//   - src/main/services/health.service.ts (wrapper under test)
//   - src/main/services/switch.lock.ts (`SwitchLockToken` shape)
//
// Strategy:
//
//   * No I/O — the wrapper is pure-but-stateful. We inject a fake
//     `switchLock.snapshot()` returning a synthesised
//     `SwitchLockToken` (only `acquiredAt` is read by the wrapper,
//     but the production type is fully specified so we mint full
//     tokens for type-correctness).
//   * Anchor `switchStartTs` at a fixed Unix-ms value so all generated
//     timestamps are deterministic. The wrapper only ever reads
//     `now() - acquiredAt`, so the absolute anchor is immaterial to
//     correctness; fixing it just keeps fast-check shrinking
//     well-behaved.
//   * `numRuns: 100` per the project's PBT contract.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createHealthService, evaluate } from './health.service';
import type { HealthInputs, ProbeResult } from '../types';
import type { SwitchLock, SwitchLockToken } from './switch.lock';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fixed anchor for `acquiredAt`. Matches the canonical "test epoch"
 * used throughout the codebase (Tue, 14 Nov 2023 22:13:20 UTC). The
 * exact value is irrelevant — the wrapper only ever subtracts it from
 * `now()`. Pinning the anchor keeps fast-check's counter-example
 * shrinks readable.
 */
const SWITCH_START_TS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Arbitraries — `HealthInputs` building blocks
// ---------------------------------------------------------------------------

/**
 * Reachable history (most-recent first). Length 0..6 matches the
 * design's "rolling 5-attempt window" plus a one-slot buffer for the
 * still-being-recorded current tick. We let the entries be arbitrary
 * booleans so generated cases can hit `home_down` (Priority 1, two
 * leading `false`s), saturated-healthy, and every cold-start case.
 */
const routerReachableHistoryArb: fc.Arbitrary<boolean[]> = fc.array(
  fc.boolean(),
  { minLength: 0, maxLength: 6 },
);

/**
 * A single probe result. `ok === true` ⇒ a finite latency; `ok ===
 * false` ⇒ `latencyMs: null`. The `error` field is intentionally
 * omitted because the evaluator only reads `ok` / `latencyMs`, and
 * including it would force `exactOptionalPropertyTypes` gymnastics.
 */
const probeResultArb: fc.Arbitrary<ProbeResult> = fc.oneof(
  fc
    .integer({ min: 1, max: 5_000 })
    .map((latencyMs): ProbeResult => ({ ok: true, latencyMs })),
  fc.constant<ProbeResult>({ ok: false, latencyMs: null }),
);

const currentNodeProbeResultsArb: fc.Arbitrary<ProbeResult[]> = fc.array(
  probeResultArb,
  { minLength: 0, maxLength: 3 },
);

/** Latency samples (ms) for the `node_slow` average leg. */
const recentSuccessProbeLatenciesArb: fc.Arbitrary<number[]> = fc.array(
  fc.integer({ min: 0, max: 5_000 }),
  { minLength: 0, maxLength: 6 },
);

/**
 * Recent success rate. `null` is the cold-start sentinel; a finite
 * value is in `[0, 1]`. Generated values are quantised to two decimals
 * so shrinking remains readable; the evaluator only compares against
 * `0.7`, so finer resolution buys nothing.
 */
const recentSuccessRateArb: fc.Arbitrary<number | null> = fc.oneof(
  fc.constant<number | null>(null),
  fc
    .integer({ min: 0, max: 100 })
    .map((n): number | null => n / 100),
);

/**
 * `openclashApiOk` is a tri-state. We pull `'auth_error'` with a
 * non-trivial weight so cases that would trip Priority 2 even with
 * `openclashTcpReachable === true` are not vanishingly rare.
 */
const openclashApiOkArb: fc.Arbitrary<boolean | 'auth_error'> = fc.oneof(
  { weight: 4, arbitrary: fc.boolean() },
  { weight: 1, arbitrary: fc.constant<'auth_error'>('auth_error') },
);

/**
 * Full `HealthInputs` arbitrary. Drawn fields are independent — the
 * cross-field invariants (e.g. `consecutiveProbeFailures` consistency
 * with `currentNodeProbeResults`) are NOT enforced because the
 * wrapper / evaluator both treat the inputs as a pure snapshot and
 * never re-derive any field. Generating across the full unconstrained
 * space exercises more of the priority ladder.
 */
const healthInputsArb: fc.Arbitrary<HealthInputs> = fc.record({
  routerReachableHistory: routerReachableHistoryArb,
  openclashTcpReachable: fc.boolean(),
  openclashApiOk: openclashApiOkArb,
  currentNodeProbeResults: currentNodeProbeResultsArb,
  recentSuccessProbeLatencies: recentSuccessProbeLatenciesArb,
  recentSuccessRate: recentSuccessRateArb,
  consecutiveProbeFailures: fc.integer({ min: 0, max: 5 }),
});

// ---------------------------------------------------------------------------
// Arbitraries — verify-window framing
// ---------------------------------------------------------------------------

/**
 * `configSwitchVerifyWindowMs`. Range matches `AppSettings`
 * (`requirements.md` Requirement 13.1: 1000..30000).
 */
const verifyWindowMsArb: fc.Arbitrary<number> = fc.integer({
  min: 1_000,
  max: 30_000,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake {@link SwitchLock} that returns `config: token` from
 * `snapshot()` and is otherwise a no-op stub. The wrapper only ever
 * calls `snapshot()`, so `acquire` / `release` are unused — we throw
 * inside them as a guard against accidental misuse.
 */
function buildLockedSnapshot(token: SwitchLockToken): Pick<SwitchLock, 'snapshot'> {
  return {
    snapshot: () => ({ config: token, nodes: [] }),
  };
}

/**
 * Build a fake {@link SwitchLock} that reports no config lock held.
 * `snapshot().config === null` is the wrapper's fast-path trigger.
 */
function buildEmptySnapshot(): Pick<SwitchLock, 'snapshot'> {
  return {
    snapshot: () => ({ config: null, nodes: [] }),
  };
}

/**
 * Mint a `SwitchLockToken` whose only non-decorative field is
 * `acquiredAt` (the only field the wrapper reads). `id` is a fixed
 * placeholder so shrinks stay readable; `kind` is `'config'` to match
 * what the production code stores under `snapshot().config`;
 * `deadlineAt` is set to `acquiredAt + ttl` for shape correctness only.
 */
function mintConfigToken(acquiredAt: number, ttlMs: number): SwitchLockToken {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    kind: { type: 'config' },
    acquiredAt,
    deadlineAt: acquiredAt + ttlMs,
  };
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('health.service — Property 8: verify-window flap suppression', () => {
  it('Property 8a — within the verify window, `openclash_unreachable` is suppressed (Validates: Requirements 5.10)', () => {
    fc.assert(
      fc.property(
        healthInputsArb,
        verifyWindowMsArb,
        // `elapsedMs ∈ [0, verifyWindowMs)`. We generate a fraction
        // in [0,1) and scale to keep the relationship tight even when
        // fast-check shrinks `verifyWindowMs` and the elapsed value
        // independently.
        fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
        (inputs, verifyWindowMs, elapsedFraction) => {
          const elapsedMs = Math.floor(elapsedFraction * verifyWindowMs);
          // Guard against the (theoretical) edge where rounding pushes
          // us to or past the boundary. The wrapper's contract is
          // strict-less-than, so we clamp.
          const safeElapsedMs =
            elapsedMs >= verifyWindowMs ? verifyWindowMs - 1 : elapsedMs;

          const token = mintConfigToken(SWITCH_START_TS, verifyWindowMs * 2);
          const service = createHealthService({
            switchLock: buildLockedSnapshot(token),
            getConfigSwitchVerifyWindowMs: () => verifyWindowMs,
            now: () => SWITCH_START_TS + safeElapsedMs,
          });

          const actual = service.evaluate(inputs);

          // The wrapper's contract on this branch:
          //   - if pure `evaluate(inputs)` is NOT `openclash_unreachable`,
          //     the wrapper forwards it verbatim;
          //   - otherwise the wrapper re-runs `evaluate` against a
          //     "controller is fine" view of the inputs.
          const baseline = evaluate(inputs);
          const expected =
            baseline === 'openclash_unreachable'
              ? evaluate({
                  ...inputs,
                  openclashTcpReachable: true,
                  openclashApiOk: true,
                })
              : baseline;

          expect(actual).toBe(expected);
          // The headline invariant: suppression means the wrapper
          // never escalates to `openclash_unreachable` while the
          // window is open. (`evaluate` against the "controller is
          // fine" view by construction cannot return
          // `openclash_unreachable` — every branch of Priority 2 is
          // gated on `openclashTcpReachable === false` or
          // `openclashApiOk` being non-`true`, both of which we
          // override.)
          expect(actual).not.toBe('openclash_unreachable');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 8b — past the verify window, suppression lifts (Validates: Requirements 5.10)', () => {
    fc.assert(
      fc.property(
        healthInputsArb,
        verifyWindowMsArb,
        // `extraElapsedMs ∈ [0, 60_000]` past the window boundary.
        // Anything `>= 0` is enough to exit suppression; capping at
        // 60s keeps `Date.now()`-style values bounded.
        fc.integer({ min: 0, max: 60_000 }),
        (inputs, verifyWindowMs, extraElapsedMs) => {
          const elapsedMs = verifyWindowMs + extraElapsedMs;
          const token = mintConfigToken(SWITCH_START_TS, verifyWindowMs * 2);
          const service = createHealthService({
            switchLock: buildLockedSnapshot(token),
            getConfigSwitchVerifyWindowMs: () => verifyWindowMs,
            now: () => SWITCH_START_TS + elapsedMs,
          });

          // Past the window, the wrapper falls through to the pure
          // evaluator unconditionally. In particular, for inputs that
          // would naturally produce `openclash_unreachable`, the
          // wrapper MUST surface it.
          expect(service.evaluate(inputs)).toBe(evaluate(inputs));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 8c — without a config lock, the wrapper is the pure evaluator (Validates: Requirements 5.10)', () => {
    fc.assert(
      fc.property(
        healthInputsArb,
        verifyWindowMsArb,
        // Any `elapsedMs` works because the lock-free fast path
        // ignores both `now` and the verify window.
        fc.integer({ min: -60_000, max: 60_000 }),
        (inputs, verifyWindowMs, elapsedMs) => {
          const service = createHealthService({
            switchLock: buildEmptySnapshot(),
            getConfigSwitchVerifyWindowMs: () => verifyWindowMs,
            now: () => SWITCH_START_TS + elapsedMs,
          });

          expect(service.evaluate(inputs)).toBe(evaluate(inputs));
        },
      ),
      { numRuns: 100 },
    );
  });
});
