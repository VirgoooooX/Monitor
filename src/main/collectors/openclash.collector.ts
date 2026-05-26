// OpenClash collector — controller API state + current-node probes.
//
// References:
//   - design.md §Health Sampling Tick
//   - design.md §Default intervals (`openclashMs = 3000`)
//   - PLAN.md §scheduler.ts (`openclashMs` task)
//   - PLAN.md §探测层 (`controller_api_ok`, `current_node_external_ok`)
//
// Responsibilities
// ----------------
// One tick of this collector:
//
//   1. Calls `GET /configs` via the OpenClash client. Records a
//      `network_samples(layer='controller_api')` row AND an
//      `openclash_snapshots` row with `api_ok`, `mode`, and the
//      identified `group_name`/`node_name`.
//
//   2. When the API is reachable (step 1 succeeded), runs `httpProbe`
//      against each configured `probeUrls` entry (timeout 5000 ms) and
//      writes one `network_samples(layer='probe')` row per URL.
//
// The probe phase shares the same tick as the API check (both run at
// `openclashMs`). If a separate probe cadence is needed in the future
// the caller can register a second task with `currentNodeMs`.
//
// Construction-time validation
// ----------------------------
// `getIntervalMs()` is validated at factory time — non-positive or
// non-finite values throw `TypeError` so a bad settings load never
// lands a degenerate task in the scheduler.
//
// Settings are re-read on every tick so edits from the Settings view
// take effect without restarting the collector.

import type { ScheduledTask } from '../scheduler';
import type {
  NetworkSamplesRepository,
  OpenClashSnapshotsRepository,
  OpenClashSnapshotStatus,
} from '../store/repositories';
import type { AppSettings } from '../types';
import { httpProbe } from './probe/httpProbe';
import type { OpenClashClient } from '../services/openclash.service';
import {
  AuthError,
  NetworkError,
} from '../services/openclash.service';
import { identifyPrimaryGroup } from '../services/openclash.groups';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable scheduler id used to identify this collector. */
export const OPENCLASH_TASK_ID = 'openclash';

/** Default per-probe HTTP timeout for `probeUrls` checks (ms). */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

/**
 * Construction-time dependencies for {@link createOpenClashCollectorTask}.
 *
 * Accessor functions (`getSettings`, `getIntervalMs`) are re-evaluated
 * on every tick so live settings edits are picked up immediately.
 */
export interface OpenClashCollectorDeps {
  repositories: {
    networkSamples: NetworkSamplesRepository;
    openclashSnapshots: OpenClashSnapshotsRepository;
  };
  /** The pre-constructed OpenClash HTTP client. */
  client: OpenClashClient;
  /** Returns the current full settings (re-read each tick). */
  getSettings: () => AppSettings;
  /** Returns the tick interval in ms (validated at construction). */
  getIntervalMs: () => number;
  /** Per-probe HTTP timeout (ms). Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  /** Wall clock; defaults to `Date.now`. Tests inject a frozen value. */
  now?: () => number;
  /**
   * Called at the end of each tick (after all writes) so the dashboard
   * service can rebroadcast. Failures inside `onAfterTick` are swallowed.
   */
  onAfterTick?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify the error from a failed `getConfigs` call into an
 * `OpenClashSnapshotStatus` tag for the `openclash_snapshots` table.
 */
function classifyApiError(err: unknown): OpenClashSnapshotStatus {
  if (err instanceof AuthError) {
    return 'auth_error';
  }
  if (err instanceof NetworkError) {
    return 'unreachable';
  }
  return 'http_error';
}

/**
 * Extract a short error description from the caught error.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || 'Error';
  }
  if (typeof err === 'string') return err;
  return 'unknown_error';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct the `openclash` collector as a {@link ScheduledTask}.
 *
 * The returned task body:
 *   1. Calls `client.getConfigs()` and `client.getProxies()` to
 *      determine controller health, mode, and the current node.
 *   2. Writes a `network_samples(layer='controller_api')` row and an
 *      `openclash_snapshots` row.
 *   3. On API success, probes each `probeUrls` entry via `httpProbe`
 *      and writes `network_samples(layer='probe')` per URL.
 *   4. Invokes `onAfterTick?.()` for dashboard rebroadcast.
 *
 * @throws {TypeError} when `getIntervalMs()` returns an invalid value
 *   at construction time.
 */
export function createOpenClashCollectorTask(
  deps: OpenClashCollectorDeps,
): ScheduledTask {
  const intervalMs = deps.getIntervalMs();
  if (
    typeof intervalMs !== 'number' ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new TypeError(
      `openclash.collector: getIntervalMs() must return a positive finite number (got ${String(
        intervalMs,
      )})`,
    );
  }

  const probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (
    typeof probeTimeoutMs !== 'number' ||
    !Number.isFinite(probeTimeoutMs) ||
    probeTimeoutMs <= 0
  ) {
    throw new TypeError(
      `openclash.collector: probeTimeoutMs must be a positive finite number (got ${String(
        probeTimeoutMs,
      )})`,
    );
  }

  const now = deps.now ?? Date.now;
  const networkRepo = deps.repositories.networkSamples;
  const snapshotRepo = deps.repositories.openclashSnapshots;
  const client = deps.client;

  return {
    id: OPENCLASH_TASK_ID,
    intervalMs,
    fn: async () => {
      const timestamp = now();
      const settings = deps.getSettings();
      const controllerUrl = settings.controllerUrl;

      // --- Phase 1: API health check via GET /configs -----------------------
      let apiOk = false;
      let mode: string | null = null;
      let groupName: string | null = null;
      let nodeName: string | null = null;
      let snapshotStatus: OpenClashSnapshotStatus = 'ok';
      let apiError: string | null = null;
      let apiLatencyStart = performance.now();

      try {
        const configsResult = await client.getConfigs();
        const apiLatencyMs = performance.now() - apiLatencyStart;

        apiOk = true;
        mode = configsResult.mode ?? null;

        // Record controller_api success sample
        networkRepo.insert({
          timestamp,
          layer: 'controller_api',
          target: controllerUrl,
          ok: true,
          latencyMs: apiLatencyMs,
          error: null,
        });

        // Get proxies to identify current group/node
        try {
          const proxiesResult = await client.getProxies();
          const primaryGroup = identifyPrimaryGroup(
            proxiesResult,
            settings.primaryGroups,
          );
          if (primaryGroup !== null) {
            groupName = primaryGroup;
            const entry = proxiesResult.proxies[primaryGroup];
            if (entry !== undefined) {
              nodeName = entry.now ?? entry.current ?? null;
            }
          }
        } catch {
          // Proxies fetch failure is non-fatal for the snapshot; we
          // still have API connectivity confirmed via /configs.
        }
      } catch (err) {
        const apiLatencyMs = performance.now() - apiLatencyStart;
        apiOk = false;
        snapshotStatus = classifyApiError(err);
        apiError = describeError(err);

        // Record controller_api failure sample
        networkRepo.insert({
          timestamp,
          layer: 'controller_api',
          target: controllerUrl,
          ok: false,
          latencyMs: apiLatencyMs > 0 ? apiLatencyMs : null,
          error: apiError,
        });
      }

      // --- Write openclash_snapshots row ------------------------------------
      snapshotRepo.insert({
        timestamp,
        apiOk,
        mode,
        groupName,
        nodeName,
        status: snapshotStatus,
      });

      // --- Phase 2: Probe URLs (only when API is ok) ------------------------
      if (apiOk && settings.probeUrls.length > 0) {
        const probePromises = settings.probeUrls.map(async (url) => {
          const result = await httpProbe(url, probeTimeoutMs);
          networkRepo.insert({
            timestamp,
            layer: 'probe',
            target: url,
            ok: result.ok,
            latencyMs: result.latencyMs,
            error: result.error ?? null,
          });
        });

        await Promise.all(probePromises);
      }

      // --- After-tick callback -----------------------------------------------
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
