// Network collector — router and OpenClash-controller TCP liveness.
//
// References:
//   - design.md §Health Sampling Tick
//   - design.md §Default intervals  (`networkMs = 3000`)
//   - design.md §Validation rules  (router host/port + controller URL)
//   - PLAN.md §scheduler.ts  (`networkMs` task)
//   - PLAN.md §探测层  (`router_reachable`, `openclash_tcp_reachable`)
//
// Responsibilities
// ----------------
// One tick of this collector probes two TCP endpoints in parallel and
// writes one row to `network_samples` per probe:
//
//   * `layer = 'router'`           — `routerHealth.host:port`
//   * `layer = 'controller_tcp'`   — host/port parsed from
//                                    `controllerUrl`
//
// The two probes are intentionally racing in parallel (`Promise.all`)
// so a slow router probe cannot delay the controller probe. Worst-case
// per tick is `probeTimeoutMs` (default 1500 ms), well inside the 3-
// second tick budget.
//
// Why this collector does NOT touch `collector_health`
// ----------------------------------------------------
// The shared scheduler (`src/main/scheduler.ts`) already routes thrown
// exceptions through its `CollectorHealthRecorder`, incrementing
// `consecutive_failures` and stamping `last_error_at` for us. If the
// collector also wrote to `collector_health` the two writers would
// race on every tick. Therefore the task body lets exceptions
// propagate; success is implied by the scheduler observing a clean
// settle of the returned promise.
//
// Why we don't fail the whole tick on a single probe error
// ---------------------------------------------------------
// `tcpProbe` resolves with `{ ok: false, error }` on every network-
// level failure (timeout, refused, DNS) and only throws on programmer
// error (invalid host/port). That means a downed router does not
// throw — it produces a row with `ok = 0` and an `error` tag, the
// scheduler counts the tick as a SUCCESS, and the dashboard / health
// evaluator picks up the failure through `network_samples`. This is
// the correct division of responsibility: collector liveness is
// orthogonal to network liveness.
//
// Construction-time validation
// ----------------------------
// `getIntervalMs()` is called once at factory time and the result is
// stamped onto the returned `ScheduledTask.intervalMs`. Negative or
// zero values throw immediately so a bad settings load never lands a
// degenerate task in the scheduler.
//
// Note on URL parsing
// -------------------
// We re-parse `controllerUrl` on every tick (rather than caching the
// result) so that a settings update applied between ticks takes
// effect on the next probe without restarting the collector. The
// per-tick cost is negligible (`new URL(...)` on a short string).

import type { ScheduledTask } from '../scheduler';
import type { NetworkSamplesRepository } from '../store/repositories';
import type { ProbeResult, RouterHealthSettings } from '../types';
import { tcpProbe } from './probe/tcpProbe';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable scheduler id used to identify this collector. */
export const NETWORK_TASK_ID = 'network';

/**
 * Default per-probe TCP timeout. Matches design.md §Default intervals
 * (`tcpProbe(... , 1500)`) and PLAN.md §探测层 ("TCP 探测 timeout:
 * `1500ms`").
 */
export const DEFAULT_NETWORK_PROBE_TIMEOUT_MS = 1500;

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

/**
 * Construction-time dependencies for {@link createNetworkCollectorTask}.
 *
 * `getRouterHealth` / `getControllerUrl` / `getIntervalMs` are
 * accessor functions (not values) so the collector picks up settings
 * edits without requiring a re-construction. The accessors are
 * called on every tick.
 *
 * `now` and `onAfterTick` exist for tests and for the dashboard
 * service's "rebroadcast after every probe write" requirement
 * (design.md §Health Sampling Tick).
 */
export interface NetworkCollectorDeps {
  repositories: { networkSamples: NetworkSamplesRepository };
  getRouterHealth: () => RouterHealthSettings;
  getControllerUrl: () => string;
  getIntervalMs: () => number;
  /** Per-probe TCP timeout. Defaults to {@link DEFAULT_NETWORK_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  /** Wall clock; defaults to `Date.now`. Tests inject a frozen value. */
  now?: () => number;
  /**
   * Called at the end of each successful tick (after both samples
   * have been written) so the dashboard service can rebroadcast.
   * Optional; failures inside `onAfterTick` are swallowed because a
   * misbehaving subscriber must not poison the next tick.
   */
  onAfterTick?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ControllerEndpoint {
  host: string;
  port: number;
  /** Display label written to `network_samples.target` (`host:port`). */
  target: string;
}

/**
 * Resolve `controllerUrl` to a TCP endpoint. We use `new URL(...)`
 * to handle both `http://host:9090` and the rarer `https://...`
 * form; a missing port falls back to the protocol's default
 * (80/443) per design.md §Validation rules.
 */
function parseControllerEndpoint(controllerUrl: string): ControllerEndpoint {
  const parsed = new URL(controllerUrl);
  const host = parsed.hostname;
  if (host.length === 0) {
    throw new TypeError(
      `network.collector: controllerUrl has no host: ${controllerUrl}`,
    );
  }
  let port: number;
  if (parsed.port.length > 0) {
    port = Number.parseInt(parsed.port, 10);
  } else if (parsed.protocol === 'https:') {
    port = 443;
  } else if (parsed.protocol === 'http:') {
    port = 80;
  } else {
    throw new TypeError(
      `network.collector: unsupported controllerUrl protocol: ${parsed.protocol}`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(
      `network.collector: controllerUrl port out of range: ${parsed.port}`,
    );
  }
  return { host, port, target: `${host}:${port}` };
}

/**
 * Format a router health setting as the `host:port` label written to
 * `network_samples.target`.
 */
function routerTarget(routerHealth: RouterHealthSettings): string {
  return `${routerHealth.host}:${routerHealth.port}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct the `network` collector as a {@link ScheduledTask}.
 *
 * The returned task body:
 *   1. Resolves `routerHealth`, `controllerUrl`, and the timestamp
 *      via `now()`.
 *   2. Runs router and controller TCP probes concurrently
 *      (`Promise.all`) — the per-tick wall time is bounded by
 *      `probeTimeoutMs`, not the sum.
 *   3. Writes one `network_samples` row per probe (`layer = 'router'`
 *      and `layer = 'controller_tcp'`), reusing the same `now()`
 *      timestamp so both rows share the same tick identity.
 *   4. Invokes `onAfterTick?.()` so the dashboard service can
 *      rebroadcast.
 *
 * Exceptions thrown by `tcpProbe` (i.e. programmer errors from
 * invalid inputs) propagate to the scheduler, which records them in
 * `collector_health.network`.
 *
 * @throws {TypeError} when `getIntervalMs()` returns a non-positive
 *   or non-finite number at construction time. Bad intervals are
 *   refused at boot rather than producing a degenerate task.
 */
export function createNetworkCollectorTask(
  deps: NetworkCollectorDeps,
): ScheduledTask {
  const intervalMs = deps.getIntervalMs();
  if (
    typeof intervalMs !== 'number' ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new TypeError(
      `network.collector: getIntervalMs() must return a positive finite number (got ${String(
        intervalMs,
      )})`,
    );
  }

  const probeTimeoutMs =
    deps.probeTimeoutMs ?? DEFAULT_NETWORK_PROBE_TIMEOUT_MS;
  if (
    typeof probeTimeoutMs !== 'number' ||
    !Number.isFinite(probeTimeoutMs) ||
    probeTimeoutMs <= 0
  ) {
    throw new TypeError(
      `network.collector: probeTimeoutMs must be a positive finite number (got ${String(
        probeTimeoutMs,
      )})`,
    );
  }

  const now = deps.now ?? Date.now;
  const repo = deps.repositories.networkSamples;

  return {
    id: NETWORK_TASK_ID,
    intervalMs,
    fn: async () => {
      const timestamp = now();
      const routerHealth = deps.getRouterHealth();
      const controller = parseControllerEndpoint(deps.getControllerUrl());

      // Race both probes; `tcpProbe` never throws on network failure.
      // We use a tuple-typed `Promise.all` (no array generic) so the
      // destructured names are statically known to exist — the array
      // overload would return `ProbeResult[]`, which under
      // `noUncheckedIndexedAccess` would type each element as
      // `ProbeResult | undefined`.
      const probes: readonly [Promise<ProbeResult>, Promise<ProbeResult>] = [
        tcpProbe(routerHealth.host, routerHealth.port, probeTimeoutMs),
        tcpProbe(controller.host, controller.port, probeTimeoutMs),
      ];
      const [routerResult, controllerResult] = await Promise.all(probes);

      repo.insert({
        timestamp,
        layer: 'router',
        target: routerTarget(routerHealth),
        ok: routerResult.ok,
        latencyMs: routerResult.latencyMs,
        error: routerResult.error ?? null,
      });

      repo.insert({
        timestamp,
        layer: 'controller_tcp',
        target: controller.target,
        ok: controllerResult.ok,
        latencyMs: controllerResult.latencyMs,
        error: controllerResult.error ?? null,
      });

      const onAfterTick = deps.onAfterTick;
      if (onAfterTick !== undefined) {
        try {
          onAfterTick();
        } catch {
          // Subscriber failure must not poison the next tick.
        }
      }
    },
  };
}
