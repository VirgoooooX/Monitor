// Dashboard composer + push-channel orchestrator.
//
// References:
//   - design.md §Health Sampling Tick
//   - design.md §Compact Window Boot — First Render
//   - design.md §Performance Considerations  (in-memory ring buffer)
//   - design.md §Data Models  (`DashboardState`)
//   - design.md §Property 15  (partial_outage decision is digest-driven)
//   - PLAN.md §UI 状态文字  (zh-CN status labels)
//
// Responsibilities
// ----------------
// `health.service.ts` is intentionally pure (Property 2): it consumes
// a `HealthInputs` value and returns a `HealthStatus`. The job of
// *building* that value from the live SQLite sample window, plus
// pushing the resulting `DashboardState` snapshot to subscribed
// renderers, lives here so the evaluator stays I/O-free.
//
// The service owns three pieces of mutable state:
//
//   1. A bounded ring buffer of the last 60 successful probe
//      latencies. This is the canonical source for both
//      `currentNode.sparkline` (60×16 SVG <polyline> in the renderer)
//      and `recentSuccessProbeLatencies` (the average that the
//      `node_slow` rule compares against the 1500 ms threshold).
//      Keeping the buffer in memory avoids a round-trip to SQLite on
//      every 3-second tick — design.md §Performance Considerations
//      explicitly carves out this optimisation.
//
//   2. The current tick's `currentProbeResults: ProbeResultDigest[]`,
//      written by the per-probe collector (lands in task 5.6) and
//      read here when building `HealthInputs`. Default empty array
//      means "no probe evidence this tick", which the evaluator
//      handles correctly (every priority that depends on probe data
//      requires `total > 0`).
//
//   3. `consecutiveProbeFailures`, also driven by the probe collector.
//      We can't compute it here — that requires history that the
//      collector already aggregates while running its retry policy —
//      so it is set externally and forwarded to `evaluate` verbatim.
//
// Push channel
// ------------
// `attachPushChannel(webContents)` registers a renderer in an
// internal `Set`; `broadcastDashboard` iterates the set and
// `webContents.send('dashboard.updated', state)`s a fresh snapshot,
// skipping (and removing) any destroyed entries. We accept
// `Electron.WebContents` rather than `BrowserWindow` so non-window
// surfaces (offscreen views, future devtools panels) can subscribe
// without forcing the caller to lift a window reference.
//
// Constructed defensively
// -----------------------
// On a cold-booted DB (every collector has yet to run for the first
// time) `compute()` must still produce a benign healthy snapshot:
//
//   * No router samples → `routerReachableHistory: []` → no two
//     leading `false`s → `home_down` cannot fire.
//   * No `controller_tcp` sample → `openclashTcpReachable: true`
//     (assume reachable until we have evidence to the contrary).
//   * No openclash snapshot → `openclashApiOk: true`, `mode/group/
//     node = null`.
//   * No probe results, empty ring buffer → every probe-driven
//     priority short-circuits, `evaluate` returns `'healthy'`.
//
// Together these defaults mean a freshly-installed app draws
// `外网正常` until the first tick provides real evidence — which is
// the right UX for "we don't know yet, don't panic".

import { averageLatency, evaluate } from './health.service';
import { isPseudoNodeName } from './openclash.groups';
import type { Repositories } from '../store/repositories';
import type { NetworkSampleRow } from '../store/repositories';
import type {
  DashboardState,
  HealthInputs,
  HealthStatus,
  ProbeResult,
  ProbeResultDigest,
} from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Capacity of the per-process ring buffer of successful probe
 * latencies. Sized to the renderer's sparkline width (60 points × 16
 * px in design.md §Performance Considerations).
 */
export const RING_BUFFER_SIZE = 60;

/**
 * How many recent router samples are inspected by `compute` to build
 * `routerReachableHistory` and to find the most recent state-change
 * timestamp. Five is a comfortable margin above the
 * "consecutive 2 failures" threshold the evaluator looks for.
 */
const ROUTER_HISTORY_WINDOW = 5;

/**
 * How many recent probe samples are tallied for `successRate5`.
 * Matches `node_slow` Priority 5's "last 5 attempts" window.
 */
const PROBE_HISTORY_WINDOW = 5;

/**
 * One day in milliseconds. Used by `usageTodayBounds` to derive a
 * `[startOfToday, now]` window for the today's-usage aggregation.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * User-facing zh-CN labels for each `HealthStatus`. The mapping is
 * total: every variant of `HealthStatus` is represented exactly once.
 *
 * Source: PLAN.md §UI 状态文字.
 */
export const HEALTH_STATUS_LABELS: Record<HealthStatus, string> = {
  healthy: '外网正常',
  node_slow: '节点变慢',
  node_down: '节点不可用',
  openclash_unreachable: 'OpenClash 不可控',
  home_down: '家里网络断',
  partial_outage: '部分外网异常',
};

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Construction-time dependencies. `getControllerUrl` /
 * `getProbeUrls` are passed as accessors rather than as values so the
 * service picks up live edits made through the Settings page without
 * needing a re-construction.
 */
export interface DashboardServiceDeps {
  repositories: Repositories;
  /** Used by future task 7.x to attribute probe results; reserved here. */
  getControllerUrl: () => string;
  /** Used by future task 7.x to attribute probe results; reserved here. */
  getProbeUrls: () => string[];
  /**
   * Wall clock. Defaults to `Date.now`. Tests inject a frozen value
   * to make `compute()` deterministic.
   */
  now?: () => number;
}

/**
 * Public surface. See module header for the design rationale of
 * each method.
 */
export interface DashboardService {
  /** Compute a fresh DashboardState from the latest samples. */
  compute(): DashboardState;
  /** Append a successful probe latency to the ring buffer. */
  pushLatencySample(latencyMs: number): void;
  /** Replace the current-tick probe results (called by collectors). */
  setCurrentProbeResults(results: readonly ProbeResultDigest[]): void;
  /** Mutate the consecutive-failure counter (router and current node). */
  setConsecutiveProbeFailures(count: number): void;
  /** Subscribe a webContents to the push channel; returns unsubscribe. */
  attachPushChannel(webContents: Electron.WebContents): () => void;
  /** Notify all attached webContents (called by collectors after each tick). */
  broadcastDashboard(): void;
  /**
   * Cold-start hydration: read the last {@link RING_BUFFER_SIZE}
   * successful probe latencies from the DB and fill the in-memory
   * ring buffer so the sparkline is populated on first render.
   * Call once at boot; subsequent ticks feed the buffer via
   * {@link pushLatencySample}.
   */
  hydrateSparklineFromDb(): void;
}

/**
 * Build a {@link DashboardService} bound to the supplied repositories
 * and live config accessors. The returned object is stateful: it
 * owns a ring buffer, a probe-result cache, and a subscriber set.
 */
export function createDashboardService(
  deps: DashboardServiceDeps,
): DashboardService {
  const repos = deps.repositories;
  const now = deps.now ?? Date.now;

  // ----- Mutable state ------------------------------------------------------

  const sparkBuffer = createNumberRingBuffer(RING_BUFFER_SIZE);
  let currentProbeResults: readonly ProbeResultDigest[] = [];
  let consecutiveProbeFailures = 0;
  const subscribers = new Set<Electron.WebContents>();

  // ----- Helpers ------------------------------------------------------------

  /**
   * Translate the latest openclash snapshot's `status` field into the
   * tri-state `HealthInputs.openclashApiOk`. A `null` snapshot
   * (cold start, no evidence yet) is treated as `true` so the
   * evaluator does not pessimistically trip
   * `openclash_unreachable` before the first tick lands.
   */
  function deriveApiOk(
    status: ReturnType<Repositories['openClashSnapshots']['latest']>,
  ): boolean | 'auth_error' {
    if (status === undefined) return true;
    if (status.status === 'ok') return true;
    if (status.status === 'auth_error') return 'auth_error';
    return false;
  }

  /**
   * Compute the timestamp at which the current router state began.
   * Newest-first samples are walked while their `ok` value matches
   * the head; the earliest match is the answer.
   *
   * Returns `0` for an empty history (nothing has ever been
   * recorded), which the renderer can interpret as "unknown".
   */
  function computeRouterLastChange(
    samples: readonly NetworkSampleRow[],
  ): number {
    const head = samples[0];
    if (head === undefined) return 0;
    let earliestSameStateTs = head.timestamp;
    for (let i = 1; i < samples.length; i += 1) {
      const sample = samples[i];
      if (sample === undefined) break;
      if (sample.ok !== head.ok) break;
      earliestSameStateTs = sample.timestamp;
    }
    return earliestSameStateTs;
  }

  /**
   * Sum total tokens (input + output + cache) per provider for the
   * range `[startOfToday, at]`. Providers with no events fall back
   * to `0`.
   *
   * The per-provider total is intentionally inclusive of cache
   * tokens because the compact UI shows a single "今日 token" number
   * (PLAN.md §UI Implementation Guide §紧凑首页) — users expect the
   * widget to reflect total volume, not the costable subset.
   */
  function computeUsageToday(at: number): {
    codex: number;
    gemini: number;
    opencode: number;
  } {
    const startOfTodayMs = startOfDayMs(at);
    const aggregates = repos.usageEvents.aggregateByProvider({
      fromTs: startOfTodayMs,
      toTs: at,
    });
    const totals = new Map<string, number>();
    for (const a of aggregates) {
      totals.set(
        a.provider,
        a.inputTokens + a.outputTokens + a.cacheTokens,
      );
    }
    return {
      codex: totals.get('codex') ?? 0,
      gemini: totals.get('gemini') ?? 0,
      opencode: totals.get('opencode') ?? 0,
    };
  }

  /**
   * Project a `ProbeResultDigest` into a `ProbeResult`. The digest
   * carries `url` for UI attribution; the evaluator only needs
   * `ok` + `latencyMs`. We intentionally omit the optional `error`
   * field — the evaluator never reads it, and
   * `exactOptionalPropertyTypes` rejects `error: undefined`.
   */
  function digestToProbeResult(d: ProbeResultDigest): ProbeResult {
    return { ok: d.ok, latencyMs: d.latencyMs };
  }

  // ----- Implementation ----------------------------------------------------

  function compute(): DashboardState {
    const at = now();

    // Router history (newest-first). Powers both the dashboard's
    // `router` view and the evaluator's `home_down` check.
    const routerRecent = repos.networkSamples.recentForLayer(
      'router',
      ROUTER_HISTORY_WINDOW,
    );
    const routerReachableHistory = routerRecent.map((r) => r.ok);
    const latestRouter = routerRecent[0];
    const routerOk = latestRouter?.ok ?? true;
    const routerLastChange = computeRouterLastChange(routerRecent);

    // OpenClash controller TCP reachability (last sample wins).
    const latestCtrlTcp =
      repos.networkSamples.latestForLayer('controller_tcp');
    const openclashTcpReachable = latestCtrlTcp?.ok ?? true;

    // OpenClash snapshot. We split the latest snapshot (drives
    // `apiOk`) from the latest *successful* one (drives `mode` /
    // `group` / `node`). Per design.md §Error Handling, when the API
    // goes down we keep showing the last-known-good metadata so the
    // user has continuity instead of `null` flicker.
    const latestSnapshot = repos.openClashSnapshots.latest();
    const lastOkSnapshot = repos.openClashSnapshots.latestOk();
    const openclashApiOk = deriveApiOk(latestSnapshot);
    const mode = lastOkSnapshot?.mode ?? null;
    const rawGroup = lastOkSnapshot?.groupName ?? null;
    const rawNode = lastOkSnapshot?.nodeName ?? null;
    const group = isPseudoNodeName(rawGroup) ? null : rawGroup;
    const node = isPseudoNodeName(rawNode) ? null : rawNode;

    // Probe success rate over the last N attempts.
    const probeRecent = repos.networkSamples.recentForLayer(
      'probe',
      PROBE_HISTORY_WINDOW,
    );
    const recentSuccessRate =
      probeRecent.length === 0
        ? null
        : probeRecent.filter((r) => r.ok).length / probeRecent.length;

    const effectiveProbeResults =
      currentProbeResults.length > 0
        ? currentProbeResults
        : probeRecent.map((sample) => ({
            url: sample.target,
            ok: sample.ok,
            latencyMs: sample.latencyMs,
          }));

    // Latency stream (sparkline + node_slow average leg).
    const sparkline = sparkBuffer.values();
    const avgLatencyMs =
      sparkline.length === 0 ? null : averageLatency(sparkline);

    // Build pure inputs and dispatch to the evaluator.
    const inputs: HealthInputs = {
      routerReachableHistory,
      openclashTcpReachable,
      openclashApiOk,
      currentNodeProbeResults: effectiveProbeResults.map(digestToProbeResult),
      recentSuccessProbeLatencies: sparkline,
      recentSuccessRate,
      consecutiveProbeFailures,
    };
    const status = evaluate(inputs);

    return {
      status,
      statusLabel: HEALTH_STATUS_LABELS[status],
      generatedAt: at,
      router: { ok: routerOk, lastChange: routerLastChange },
      openclash: {
        tcpOk: openclashTcpReachable,
        apiOk: openclashApiOk,
        mode,
      },
      currentNode: {
        group,
        node,
        avgLatencyMs,
        // Defensive copy: the renderer should never see the same
        // array reference across two `compute()` calls.
        probeResults: effectiveProbeResults.map((d) => ({
          url: d.url,
          ok: d.ok,
          latencyMs: d.latencyMs,
        })),
        successRate5: recentSuccessRate,
        sparkline,
      },
      usageToday: computeUsageToday(at),
    };
  }

  function pushLatencySample(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      // Defensive: drop non-finite or negative samples. The evaluator
      // already tolerates them via `averageLatency`'s NaN filter, but
      // keeping the buffer clean simplifies the renderer's sparkline.
      return;
    }
    sparkBuffer.push(latencyMs);
  }

  function setCurrentProbeResults(
    results: readonly ProbeResultDigest[],
  ): void {
    // Snapshot the input. If the caller mutates their array later we
    // do not want `compute()` to observe the change mid-tick.
    currentProbeResults = results.map((d) => ({
      url: d.url,
      ok: d.ok,
      latencyMs: d.latencyMs,
    }));
  }

  function setConsecutiveProbeFailures(count: number): void {
    if (!Number.isFinite(count) || count < 0) {
      consecutiveProbeFailures = 0;
      return;
    }
    consecutiveProbeFailures = Math.floor(count);
  }

  function attachPushChannel(
    webContents: Electron.WebContents,
  ): () => void {
    subscribers.add(webContents);
    let detached = false;
    const unsubscribe = (): void => {
      if (detached) return;
      detached = true;
      subscribers.delete(webContents);
    };
    // Auto-clean when the renderer goes away. `destroyed` fires
    // exactly once per webContents lifecycle.
    webContents.once('destroyed', unsubscribe);
    return unsubscribe;
  }

  function broadcastDashboard(): void {
    if (subscribers.size === 0) return;
    const state = compute();
    // Snapshot the set so concurrent unsubscribes during iteration do
    // not skip an entry.
    for (const wc of [...subscribers]) {
      if (wc.isDestroyed()) {
        subscribers.delete(wc);
        continue;
      }
      try {
        wc.send('dashboard.updated', state);
      } catch {
        // A failed send is not fatal — the renderer might have been
        // torn down between our `isDestroyed` check and `send`. Drop
        // the subscriber and continue.
        subscribers.delete(wc);
      }
    }
  }

  function hydrateSparklineFromDb(): void {
    // Cold-start path: read the last RING_BUFFER_SIZE successful probe
    // samples from DB (newest first), reverse to insertion order, and
    // push into the ring buffer. This populates the sparkline on first
    // render without requiring the collector to have run yet.
    const recent = repos.networkSamples.recentForLayer(
      'probe',
      RING_BUFFER_SIZE,
    );
    // `recentForLayer` returns newest-first; we need oldest-first for
    // correct ring buffer insertion order.
    const oldestFirst = recent.reverse();
    for (const sample of oldestFirst) {
      if (sample.ok && sample.latencyMs !== null && sample.latencyMs >= 0) {
        sparkBuffer.push(sample.latencyMs);
      }
    }
  }

  return {
    compute,
    pushLatencySample,
    setCurrentProbeResults,
    setConsecutiveProbeFailures,
    attachPushChannel,
    broadcastDashboard,
    hydrateSparklineFromDb,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Truncate a Unix-ms timestamp to the start of its local day.
 * Lifted into a helper so tests (and future task 5.x usage panels)
 * have a single, audited definition of "today".
 */
function startOfDayMs(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  const ms = d.getTime();
  // Date math can return NaN for non-finite inputs; fall back to a
  // conservative midnight-relative-to-now to keep the aggregate
  // query well-defined.
  if (!Number.isFinite(ms)) {
    return Math.max(0, at - ONE_DAY_MS);
  }
  return ms;
}

/**
 * Minimal FIFO ring buffer over numbers. Capacity-bounded
 * (oldest entry is dropped on overflow). `values()` returns a defensive
 * copy in insertion order so callers cannot mutate the buffer's
 * internal storage.
 *
 * Kept module-private (no `export`) because the dashboard service is
 * the only consumer in v1; if a future task needs a generic ring
 * buffer it can lift this helper into `src/main/store/`.
 */
interface NumberRingBuffer {
  push(value: number): void;
  values(): number[];
  readonly length: number;
}

function createNumberRingBuffer(capacity: number): NumberRingBuffer {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(
      `createNumberRingBuffer: capacity must be a positive integer, got ${String(capacity)}`,
    );
  }
  const data: number[] = [];
  return {
    push(value: number): void {
      data.push(value);
      if (data.length > capacity) {
        data.shift();
      }
    },
    values(): number[] {
      return data.slice();
    },
    get length(): number {
      return data.length;
    },
  };
}
