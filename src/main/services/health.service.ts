// Health status evaluator — the pure decision function at the heart of
// the dashboard's status hero.
//
// References:
//   - design.md §Health Status Evaluation (algorithmic pseudocode)
//   - design.md §Property 1  (priority is total and short-circuiting)
//   - design.md §Property 2  (evaluation is pure)
//   - design.md §Property 3  (home_down requires consecutive-2 failures)
//   - design.md §Property 4  (auth_error triggers openclash_unreachable)
//   - design.md §Property 14 (node_down requires API alive)
//   - design.md §Property 15 (partial_outage requires mixed probe results)
//   - PLAN.md §状态判定
//
// Design choices encoded here:
//
// - **Pure function, no I/O**. Per Property 2 the evaluator must be
//   referentially transparent. The caller (the health controller in
//   `computeDashboard`) is responsible for assembling `HealthInputs`
//   from SQLite samples and the in-memory ring buffer; this module
//   only reasons over the value passed in. We intentionally take no
//   imports beyond `../types` so any accidental I/O dependency would
//   be caught at the module boundary.
// - **Caller-supplied `consecutiveProbeFailures`**. Detecting "two ticks
//   in a row failed" requires history. Reading history is an I/O call,
//   which would break Property 2. The design.md pseudocode therefore
//   threads the consecutive-fail count in as a precomputed input
//   (see the `HealthInputs` JSDoc in `../types`). This module trusts
//   the caller's count and uses it verbatim.
// - **Priority ladder is short-circuit**. Property 1 requires that the
//   highest-priority active status wins. The function therefore uses
//   sequential `if` returns rather than scoring; each branch implies
//   the falsity of every higher-priority predicate, which is what the
//   per-branch documentation calls out.
// - **Empty-input safety**. `routerReachableHistory.length < 2` cannot
//   produce `home_down` (we require two leading `false` entries). An
//   empty `currentNodeProbeResults` array means we have no probe
//   evidence this tick — we skip `node_down` (Priority 3 needs
//   `total > 0`) and `partial_outage` (Priority 4 needs at least one
//   of each), but we still let `node_slow` fire on a poor historical
//   `recentSuccessRate` (the rate is itself nullable for cold start).
// - **`averageLatency([]) = 0`**. The `node_slow` predicate compares
//   against `1500`. Returning `0` for an empty history makes the
//   threshold check well-defined (no NaN propagation) and falsy for
//   the average leg of the OR — the rate leg can still trigger.

import type { HealthInputs, HealthStatus, ProbeResult } from '../types';

/** Priority 1: how many leading `false` entries are required for `home_down`. */
const HOME_DOWN_CONSECUTIVE_THRESHOLD = 2;
/** Priority 3: how many consecutive probe failures qualify as `node_down`. */
const NODE_DOWN_CONSECUTIVE_THRESHOLD = 2;
/** Priority 5: average latency above this (ms) flips an otherwise-OK node to `node_slow`. */
const NODE_SLOW_LATENCY_MS = 1_500;
/** Priority 5: success rate below this (0..1) flips an otherwise-OK node to `node_slow`. */
const NODE_SLOW_SUCCESS_RATE = 0.7;

/**
 * Count the number of leading `false` entries in a most-recent-first
 * boolean history. The count stops at the first `true` (or at the end
 * of the array). Used by Priority 1 to detect "router unreachable for
 * the last two ticks in a row".
 *
 * Pure, total: returns `0` for an empty array.
 */
function countLeadingFalse(history: readonly boolean[]): number {
  let count = 0;
  for (const reachable of history) {
    if (reachable !== false) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * Average a list of latency samples (ms). Returns `0` when the input
 * is empty, which is the documented sentinel for "no successful
 * probes recorded yet" — the `node_slow` threshold check then evaluates
 * to false on the average leg, leaving the success-rate leg to decide.
 *
 * Pure, total. Non-finite samples (NaN/Infinity) are ignored to keep
 * the result deterministic in the face of upstream parsing bugs.
 */
export function averageLatency(latencies: readonly number[]): number {
  if (latencies.length === 0) {
    return 0;
  }
  let sum = 0;
  let n = 0;
  for (const value of latencies) {
    if (Number.isFinite(value)) {
      sum += value;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Tally success/failure counts over the current tick's probe results.
 * Encapsulated here so the priority ladder reads as a series of
 * predicates rather than a sequence of fold operations.
 */
function tallyProbeResults(
  results: readonly ProbeResult[],
): { successCount: number; failCount: number; total: number } {
  let successCount = 0;
  let failCount = 0;
  for (const r of results) {
    if (r.ok) {
      successCount += 1;
    } else {
      failCount += 1;
    }
  }
  return { successCount, failCount, total: successCount + failCount };
}

/**
 * Evaluate the current health status from a snapshot of the latest
 * sample window.
 *
 * The function applies the six-step priority ladder defined in
 * `design.md §Health Status Evaluation`. Higher-priority statuses
 * short-circuit lower-priority ones (Property 1). The function is
 * deterministic and pure (Property 2): the same `inputs` will always
 * produce the same result and no I/O is performed.
 *
 * Priority ladder (high → low):
 * 1. `home_down` — at least {@link HOME_DOWN_CONSECUTIVE_THRESHOLD}
 *    consecutive most-recent `false` entries in
 *    `routerReachableHistory` (Property 3).
 * 2. `openclash_unreachable` — controller TCP unreachable, API
 *    explicitly false, or API returned `'auth_error'` (Property 4).
 * 3. `node_down` — API is alive, every current probe failed, and the
 *    caller-supplied `consecutiveProbeFailures` flag is at least
 *    {@link NODE_DOWN_CONSECUTIVE_THRESHOLD} (Property 14).
 * 4. `partial_outage` — at least one probe succeeded **and** at least
 *    one failed this tick (Property 15).
 * 5. `node_slow` — every current probe succeeded but the recent
 *    average latency exceeds {@link NODE_SLOW_LATENCY_MS} or the recent
 *    success rate is below {@link NODE_SLOW_SUCCESS_RATE}.
 * 6. `healthy` — none of the above apply.
 *
 * @param inputs Pure snapshot of the latest sample window.
 * @returns The single, highest-priority status implied by `inputs`.
 */
export function evaluate(inputs: HealthInputs): HealthStatus {
  // Priority 1 — home_down.
  // We trust only the leading run of `false` entries. A short history
  // (< 2 entries) cannot produce two consecutive failures and therefore
  // never trips this branch on cold start.
  const routerFails = countLeadingFalse(inputs.routerReachableHistory);
  if (routerFails >= HOME_DOWN_CONSECUTIVE_THRESHOLD) {
    return 'home_down';
  }

  // Priority 2 — openclash_unreachable.
  // `openclashApiOk` is a tri-state: `true` (200 OK), `false` (any
  // non-auth controller failure), or `'auth_error'` (401, controller is
  // alive but our credentials are bad). Per Property 4 we collapse the
  // last two onto `openclash_unreachable`.
  if (
    inputs.openclashTcpReachable === false ||
    inputs.openclashApiOk === false ||
    inputs.openclashApiOk === 'auth_error'
  ) {
    return 'openclash_unreachable';
  }

  // From here on `openclashApiOk === true` is implied (Property 14).
  const { successCount, failCount, total } = tallyProbeResults(
    inputs.currentNodeProbeResults,
  );

  // Priority 3 — node_down.
  // Requires evidence (`total > 0`) that every probe failed this tick
  // *and* the caller's history-aware count agrees the node has been
  // failing for at least two consecutive ticks. Without `total > 0`
  // we cannot distinguish "node is dead" from "no probes scheduled".
  if (
    total > 0 &&
    successCount === 0 &&
    inputs.consecutiveProbeFailures >= NODE_DOWN_CONSECUTIVE_THRESHOLD
  ) {
    return 'node_down';
  }

  // Priority 4 — partial_outage.
  // Property 15 forbids this branch from depending on which URL
  // succeeded; we look only at the counts.
  if (successCount >= 1 && failCount >= 1) {
    return 'partial_outage';
  }

  // From here on `failCount === 0`. Either every probe succeeded, or
  // the caller has not produced any probe evidence this tick. Both
  // cases are handled identically by the slow/healthy split below —
  // the latency/rate thresholds remain meaningful when fed historical
  // (rather than current-tick) data, and `averageLatency([])` returns
  // `0` so an empty history cannot incorrectly trip the slow threshold.

  // Priority 5 — node_slow.
  const avgLatency = averageLatency(inputs.recentSuccessProbeLatencies);
  const rate = inputs.recentSuccessRate;
  if (
    avgLatency > NODE_SLOW_LATENCY_MS ||
    (rate !== null && rate < NODE_SLOW_SUCCESS_RATE)
  ) {
    return 'node_slow';
  }

  // Priority 6 — healthy.
  return 'healthy';
}
