// Retention cleanup job for the application's own SQLite database.
//
// References:
//   - design.md §Retention Cleanup, §Property 9 (Retention monotonicity)
//   - PLAN.md §SQLite Schema (retention)
//
// Design notes:
//   - Only the five sample/event tables are pruned. `settings`,
//     `secrets`, and `collector_health` are explicitly NOT touched —
//     this is half of the §Property 9 contract.
//   - All five `DELETE` statements run inside a single transaction so
//     a crash or an exception leaves the DB in either the pre- or
//     post-cleanup state, never half-pruned.
//   - After committing we run `PRAGMA wal_checkpoint(TRUNCATE)` so the
//     -wal file does not grow unbounded between cleanups; this is the
//     final step in the §Retention Cleanup pseudocode.
//   - `cleanup` is synchronous (better-sqlite3 is synchronous), but
//     `createRetentionTask` wraps it in an async `fn` because the
//     scheduler contract (`scheduler.ts`) demands a `Promise<void>`.
//   - The scheduler is responsible for catching errors and routing
//     them to `collector_health`; we deliberately do NOT swallow
//     exceptions here. The caller (app.ts task 1.14) registers this
//     task and invokes `runNow('retention')` at boot.

import type { MonitorDatabase } from './db';
import type { ScheduledTask } from '../scheduler';

/** Stable scheduler id for the retention job. */
export const RETENTION_TASK_ID = 'retention';

/** Default retention window — design.md §Retention Cleanup. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Default scheduling interval: every 60 minutes. */
export const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Options accepted by {@link cleanup}. */
export interface RetentionCleanupOptions {
  /** Retention window in days. Must be a finite number ≥ 0. Defaults to 30. */
  retentionDays?: number;
  /** Clock source; defaults to `Date.now`. Injected for deterministic tests. */
  now?: () => number;
}

/** Per-table delete counts captured from `RunResult.changes`. */
export interface RetentionRemovedCounts {
  networkSamples: number;
  openclashSnapshots: number;
  nodeSamples: number;
  usageEvents: number;
  openclashConfigChanges: number;
}

/** Return shape of {@link cleanup}; useful for diagnostics and tests. */
export interface RetentionCleanupResult {
  /** Epoch ms boundary used by the five `DELETE` statements. */
  cutoff: number;
  /** Number of rows deleted from each pruned table. */
  removed: RetentionRemovedCounts;
}

function resolveRetentionDays(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION_DAYS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `retention.cleanup: retentionDays must be a finite non-negative number (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * Prune the five sample/event tables to a rolling window.
 *
 * Postconditions (design.md §Property 9):
 *   - No surviving row in `network_samples`, `openclash_snapshots`,
 *     `node_samples`, `usage_events`, or `openclash_config_changes`
 *     has `timestamp < cutoff`.
 *   - Rows in `settings`, `secrets`, and `collector_health` are
 *     unchanged.
 *   - The WAL file has been checkpointed and truncated.
 *
 * @param db        Open application database (read-write).
 * @param options   Optional retention window and clock overrides.
 * @returns         The cutoff used and per-table removal counts.
 */
export function cleanup(
  db: MonitorDatabase,
  options?: RetentionCleanupOptions,
): RetentionCleanupResult {
  const retentionDays = resolveRetentionDays(options?.retentionDays);
  const now = options?.now ?? Date.now;
  const cutoff = now() - retentionDays * MS_PER_DAY;

  // Prepare-once; the same statements are reused on every cleanup
  // call. better-sqlite3 caches statements per-connection so this is
  // cheap, but it also keeps the txn body free of allocation.
  const deleteNetworkSamples = db.prepare<[number]>(
    'DELETE FROM network_samples WHERE timestamp < ?',
  );
  const deleteOpenClashSnapshots = db.prepare<[number]>(
    'DELETE FROM openclash_snapshots WHERE timestamp < ?',
  );
  const deleteNodeSamples = db.prepare<[number]>(
    'DELETE FROM node_samples WHERE timestamp < ?',
  );
  const deleteUsageEvents = db.prepare<[number]>(
    'DELETE FROM usage_events WHERE timestamp < ?',
  );
  const deleteOpenClashConfigChanges = db.prepare<[number]>(
    'DELETE FROM openclash_config_changes WHERE timestamp < ?',
  );

  // Single transaction — all five deletes commit or roll back together.
  // The three tables that must remain untouched (settings, secrets,
  // collector_health) are simply absent from this block.
  const removed: RetentionRemovedCounts = {
    networkSamples: 0,
    openclashSnapshots: 0,
    nodeSamples: 0,
    usageEvents: 0,
    openclashConfigChanges: 0,
  };

  const runDeletes = db.transaction((boundary: number) => {
    removed.networkSamples = deleteNetworkSamples.run(boundary).changes;
    removed.openclashSnapshots = deleteOpenClashSnapshots.run(boundary).changes;
    removed.nodeSamples = deleteNodeSamples.run(boundary).changes;
    removed.usageEvents = deleteUsageEvents.run(boundary).changes;
    removed.openclashConfigChanges =
      deleteOpenClashConfigChanges.run(boundary).changes;
  });
  runDeletes(cutoff);

  // Truncate the WAL file so it cannot grow unbounded across cleanups.
  // Skip for in-memory databases (which don't use WAL at all) — tests
  // open `:memory:` for speed.
  if (!db.memory) {
    db.pragma('wal_checkpoint(TRUNCATE)');
  }

  return { cutoff, removed };
}

/** Options for {@link createRetentionTask}. */
export interface RetentionTaskOptions extends RetentionCleanupOptions {
  /**
   * Interval between auto-fires. Defaults to
   * {@link DEFAULT_RETENTION_INTERVAL_MS} (60 minutes). Tests may pass
   * a smaller value; the scheduler validates it is positive.
   */
  intervalMs?: number;
  /**
   * Called with the result of every successful cleanup. Useful for
   * diagnostics counters; exceptions thrown here propagate to the
   * scheduler's error path.
   */
  onResult?: (result: RetentionCleanupResult) => void;
  /**
   * Forwarded to {@link ScheduledTask.onError}. Invoked AFTER the
   * scheduler has already recorded the failure on `collector_health`.
   */
  onError?: (e: unknown) => void;
}

/**
 * Build a {@link ScheduledTask} that prunes the sample tables on
 * every tick. The caller is responsible for `scheduler.register(...)`
 * and the boot-time `scheduler.runNow(RETENTION_TASK_ID)` (task 1.14).
 *
 * The returned task has:
 *   - `id` = {@link RETENTION_TASK_ID}
 *   - `intervalMs` = `options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS`
 *   - `fn` = async wrapper around {@link cleanup}, forwarding the
 *     resolved `retentionDays` / `now` options.
 */
export function createRetentionTask(
  db: MonitorDatabase,
  options?: RetentionTaskOptions,
): ScheduledTask {
  const intervalMs = options?.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;
  // Snapshot the cleanup-time options so later mutation of the
  // caller's object cannot change the task's behaviour mid-run.
  const cleanupOptions: RetentionCleanupOptions = {};
  if (options?.retentionDays !== undefined) {
    cleanupOptions.retentionDays = options.retentionDays;
  }
  if (options?.now !== undefined) {
    cleanupOptions.now = options.now;
  }
  const onResult = options?.onResult;
  const onError = options?.onError;

  const task: ScheduledTask = {
    id: RETENTION_TASK_ID,
    intervalMs,
    fn: async (): Promise<void> => {
      const result = cleanup(db, cleanupOptions);
      if (onResult !== undefined) {
        onResult(result);
      }
    },
  };
  // exactOptionalPropertyTypes forbids `onError: undefined` in the
  // literal; attach it conditionally instead.
  if (onError !== undefined) {
    task.onError = onError;
  }
  return task;
}
