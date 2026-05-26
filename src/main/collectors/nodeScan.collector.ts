// Node-table rolling scan collector — tests a batch of ≤ 10 nodes per tick.
//
// References:
//   - design.md §`scheduler.ts` defaults (`nodeScanMs = 60000`)
//   - PLAN.md §scheduler.ts §节点列表滚动测速
//
// Responsibilities
// ----------------
// Each tick:
//   1. Fetches the primary group's option list via `client.getProxies()`.
//   2. Filters out DIRECT/REJECT/GLOBAL pseudo-nodes.
//   3. Reads the rolling cursor from `settings('nodeScan.cursor')`.
//   4. Selects the next ≤ 10 nodes starting from the cursor.
//   5. For each selected node, calls `client.testNodeDelay(...)` and
//      writes the result to the `node_samples` repository.
//   6. Advances and persists the cursor.
//
// The cursor wraps around when it reaches the end of the filtered list.
// If the node list shrinks between ticks (e.g. user removed providers),
// the cursor is clamped to the new length.

import type { ScheduledTask } from '../scheduler';
import type {
  NodeSamplesRepository,
  SettingsRepository,
} from '../store/repositories';
import type { AppSettings } from '../types';
import type { OpenClashClient } from '../services/openclash.service';
import { EXCLUDED_NODE_NAMES } from '../services/openclash.groups';
import { identifyPrimaryGroup } from '../services/openclash.groups';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable scheduler id used to identify this collector. */
export const NODE_SCAN_TASK_ID = 'nodeScan';

/** Settings key for the rolling cursor. */
export const NODE_SCAN_CURSOR_KEY = 'nodeScan.cursor';

/** Maximum number of nodes tested per tick. */
export const BATCH_SIZE = 10;

/** Default probe URL used for delay testing. */
export const DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204';

/** Default per-node probe timeout (ms). */
export const DEFAULT_NODE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

export interface NodeScanCollectorDeps {
  repositories: {
    nodeSamples: NodeSamplesRepository;
    settings: SettingsRepository;
  };
  /** The pre-constructed OpenClash HTTP client. */
  client: OpenClashClient;
  /** Returns the current full settings (re-read each tick). */
  getSettings: () => AppSettings;
  /** Returns the tick interval in ms (validated at construction). */
  getIntervalMs: () => number;
  /** Probe URL for delay tests. Defaults to {@link DEFAULT_PROBE_URL}. */
  probeUrl?: string;
  /** Per-node timeout in ms. Defaults to {@link DEFAULT_NODE_TIMEOUT_MS}. */
  nodeTimeoutMs?: number;
  /** Wall clock; defaults to `Date.now`. Tests inject a frozen value. */
  now?: () => number;
  /** Called at the end of each tick for dashboard rebroadcast. */
  onAfterTick?: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct the `nodeScan` collector as a {@link ScheduledTask}.
 *
 * @throws {TypeError} when `getIntervalMs()` returns an invalid value
 *   at construction time.
 */
export function createNodeScanCollectorTask(
  deps: NodeScanCollectorDeps,
): ScheduledTask {
  const intervalMs = deps.getIntervalMs();
  if (
    typeof intervalMs !== 'number' ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new TypeError(
      `nodeScan.collector: getIntervalMs() must return a positive finite number (got ${String(
        intervalMs,
      )})`,
    );
  }

  const now = deps.now ?? Date.now;
  const probeUrl = deps.probeUrl ?? DEFAULT_PROBE_URL;
  const nodeTimeoutMs = deps.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS;
  const nodeSamplesRepo = deps.repositories.nodeSamples;
  const settingsRepo = deps.repositories.settings;
  const client = deps.client;

  return {
    id: NODE_SCAN_TASK_ID,
    intervalMs,
    fn: async () => {
      const timestamp = now();
      const settings = deps.getSettings();

      // --- Fetch node list from primary group ---
      let proxiesResult;
      try {
        proxiesResult = await client.getProxies();
      } catch {
        // If we cannot reach the controller, skip this tick silently.
        // The openclash collector already records API failures.
        return;
      }

      const primaryGroup = identifyPrimaryGroup(
        proxiesResult,
        settings.primaryGroups,
      );
      if (primaryGroup === null) {
        return;
      }

      const groupEntry = proxiesResult.proxies[primaryGroup];
      if (groupEntry === undefined || groupEntry.all === undefined) {
        return;
      }

      // Filter out pseudo-nodes
      const filteredNodes = groupEntry.all.filter(
        (name) => !EXCLUDED_NODE_NAMES.has(name),
      );

      if (filteredNodes.length === 0) {
        return;
      }

      // --- Read and clamp cursor ---
      let cursor = settingsRepo.get<number>(NODE_SCAN_CURSOR_KEY) ?? 0;
      if (cursor < 0 || cursor >= filteredNodes.length) {
        cursor = 0;
      }

      // --- Select batch ---
      const batch: string[] = [];
      for (let i = 0; i < BATCH_SIZE && i < filteredNodes.length; i++) {
        const idx = (cursor + i) % filteredNodes.length;
        const node = filteredNodes[idx];
        if (node !== undefined) {
          batch.push(node);
        }
      }

      // --- Advance cursor ---
      const nextCursor = (cursor + batch.length) % filteredNodes.length;
      settingsRepo.set<number>(NODE_SCAN_CURSOR_KEY, nextCursor);

      // --- Test each node ---
      const probePromises = batch.map(async (nodeName) => {
        try {
          const result = await client.testNodeDelay(
            nodeName,
            probeUrl,
            nodeTimeoutMs,
          );
          nodeSamplesRepo.insert({
            timestamp,
            groupName: primaryGroup,
            nodeName,
            source: null,
            delayMs: result.delay,
            ok: result.ok,
            error: result.error ?? null,
          });
        } catch {
          // AuthError or unexpected errors — record as failure
          nodeSamplesRepo.insert({
            timestamp,
            groupName: primaryGroup,
            nodeName,
            source: null,
            delayMs: null,
            ok: false,
            error: 'auth_error',
          });
        }
      });

      await Promise.all(probePromises);

      // --- After-tick callback ---
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
