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
import type { SwitchLock } from './switch.lock';

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

// ---------------------------------------------------------------------------
// Verify-window flap suppression (Requirement 5.10, design.md §Property 8)
// ---------------------------------------------------------------------------
//
// The pure `evaluate` above stays I/O-free per Property 2. The wrapper
// below adds the **only** state-aware tweak the requirements impose:
// during an in-flight Config_Switch the OpenClash controller is
// expected to flap (LuCI's `/etc/init.d/openclash restart` knocks the
// API offline for a few seconds). Promoting that flap to
// `openclash_unreachable` would scare the user with a transient error
// during a normal switch.
//
// Requirement 5.10:
//   WHEN Config_Switch 期间 Controller_API 短暂不可达且持续时间不超过
//   Config_Switch_Verify_Window_Ms, THE System SHALL 不把该状态升级为
//   `openclash_unreachable`; 超出该窗口仍不可达时方按既有规则升级.
//
// The check is intentionally narrow:
//   1. Only `openclash_unreachable` is suppressed. Every other status
//      flows through unchanged — `home_down` still wins (the router
//      is unrelated to Config_Switch), and once the wrapper decides
//      "do not escalate" we re-run the pure evaluator with a synthetic
//      "controller is fine" view of the inputs so it can still surface
//      `partial_outage` / `node_slow` / `node_down` based on the rest
//      of the evidence.
//   2. The suppression window is keyed off the lock's `acquiredAt`
//      timestamp (the moment `acquire('config', _)` returned a token).
//      That stamp is the exact "switch start time" Requirement 5.10
//      refers to — using it sidesteps having to thread a separate
//      down-streak start through the inputs and keeps `evaluate`
//      pure.
//   3. Once `now() - acquiredAt >= configSwitchVerifyWindowMs`, the
//      switch has dragged on too long; we resume normal escalation.
//      A subsequent watchdog force-release (Property 7) is independent
//      of this branch — by the time the watchdog fires the lock is
//      already gone, so `snapshot()` reports `config: null` and the
//      wrapper trivially short-circuits to `evaluate(inputs)`.

/**
 * Construction-time dependencies for {@link createHealthService}.
 *
 * Every dependency is optional so callers (notably `dashboard.service`)
 * can construct a partially-wired service while later tasks land their
 * pieces. With **no** deps the wrapper is observationally equivalent to
 * the pure {@link evaluate}, which keeps backwards compatibility for
 * the cold-boot path.
 */
export interface HealthServiceDeps {
  /**
   * Read-only view onto the global switch lock. The wrapper only
   * inspects `snapshot().config`; it never acquires or releases.
   * Defaults to "no config switch in flight" when omitted, which is
   * the correct fallback before task 10.4 wires the lock at the
   * application root.
   */
  switchLock?: Pick<SwitchLock, 'snapshot'>;
  /**
   * Live read of `AppSettings.configSwitchVerifyWindowMs`. Read on
   * every `evaluate` call so user edits in Settings (task 9.1) take
   * effect immediately. Defaults to `8_000` (the design.md Q4
   * resolution) when omitted.
   */
  getConfigSwitchVerifyWindowMs?: () => number;
  /**
   * Wall clock. Defaults to `Date.now`. Tests inject a virtual clock
   * so the property test in 12.2 can drive deterministic timing.
   */
  now?: () => number;
}

/**
 * Stateful façade around {@link evaluate}. The pure function is still
 * the source of truth — this wrapper only intervenes on the single
 * branch called out by Requirement 5.10.
 */
export interface HealthService {
  /**
   * Evaluate the health status from a snapshot of the latest sample
   * window, applying verify-window flap suppression when a
   * Config_Switch is in flight. Pure {@link evaluate} fallback is
   * used whenever the suppression conditions are not all met.
   */
  evaluate(inputs: HealthInputs): HealthStatus;
}

/**
 * Default `configSwitchVerifyWindowMs` used when the dep accessor is
 * omitted. Matches `buildDefaultAppSettings()` in `app.ts` — kept in
 * sync by hand because lifting the constant out of `app.ts` would
 * pull a runtime dependency into this otherwise-pure module.
 */
const DEFAULT_CONFIG_SWITCH_VERIFY_WINDOW_MS = 8_000;

/**
 * Build a {@link HealthService}. Every dep is optional; the resulting
 * object is safe to call from the very first tick after boot, even
 * before the switch lock has been wired (task 10.4).
 */
export function createHealthService(
  deps?: HealthServiceDeps,
): HealthService {
  const switchLock = deps?.switchLock ?? null;
  const getVerifyWindowMs =
    deps?.getConfigSwitchVerifyWindowMs ??
    ((): number => DEFAULT_CONFIG_SWITCH_VERIFY_WINDOW_MS);
  const now = deps?.now ?? Date.now;

  return {
    evaluate(inputs: HealthInputs): HealthStatus {
      // Fast path: when no `'config'` lock is held there is nothing
      // to suppress. The pure evaluator decides every status,
      // including `openclash_unreachable`.
      const baseline = evaluate(inputs);
      if (switchLock === null) {
        return baseline;
      }

      // The suppression branch only fires when the pure evaluator
      // already wants to escalate. Any other status (including
      // `home_down`, which has higher priority than
      // `openclash_unreachable`) is forwarded verbatim.
      if (baseline !== 'openclash_unreachable') {
        return baseline;
      }

      // Read the lock state. `snapshot()` returns fresh copies — the
      // call is O(1) for the common case (zero or one config token).
      const lockState = switchLock.snapshot();
      const configToken = lockState.config;
      if (configToken === null) {
        // No Config_Switch in flight — Requirement 5.10's premise
        // ("WHEN Config_Switch 期间…") is not satisfied, so the
        // pure evaluator's verdict stands.
        return baseline;
      }

      // Compute the elapsed time since the switch started. We compare
      // against the **live** verify window so changing the setting
      // mid-switch (allowed by the schema) takes effect immediately.
      const verifyWindowMs = getVerifyWindowMs();
      const elapsed = now() - configToken.acquiredAt;
      if (elapsed >= verifyWindowMs) {
        // The switch has dragged past the window. Per Requirement
        // 5.10 ("超出该窗口仍不可达时方按既有规则升级") we resume
        // normal escalation behaviour.
        return baseline;
      }

      // Suppression active: re-run the pure evaluator with a
      // synthetic view of the inputs that pretends the controller is
      // healthy. This lets every lower-priority status (node_down,
      // partial_outage, node_slow) still surface based on the rest
      // of the evidence — only the controller-half of the priority
      // ladder is silenced.
      //
      // We deliberately do NOT touch the router-history half: a
      // genuinely unreachable router still trips `home_down`, which
      // already short-circuited above (it is higher priority than
      // `openclash_unreachable`).
      const suppressed: HealthInputs = {
        ...inputs,
        openclashTcpReachable: true,
        openclashApiOk: true,
      };
      return evaluate(suppressed);
    },
  };
}
