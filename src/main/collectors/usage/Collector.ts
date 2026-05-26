// Usage collector contract and shared helpers.
//
// References:
//   - design.md §Collectors — Common Contract
//   - PLAN.md §AI Usage Collectors 通用约定
//
// Every usage collector (codex, gemini, antigravity, opencode, deepseek)
// implements `UsageCollector`. The `runUsageCollector` wrapper orchestrates
// the capability check → tick → "ok with all zeros" guard → persistence
// pipeline so individual collectors stay focused on scan logic only.

import type { CapabilityResult } from '../../types';
import type { SettingsRepository } from '../../store/repositories';
import type { UsageEventsRepository } from '../../store/repositories';
import type { CollectorHealthRepository } from '../../store/repositories';

// ---------------------------------------------------------------------------
// Context passed into every usage collector tick
// ---------------------------------------------------------------------------

/**
 * Shared context provided by the runner to each collector's `tick`.
 * Collectors should use these handles instead of importing singletons
 * so they remain testable in isolation.
 */
export interface UsageCollectorContext {
  /** Repository for inserting usage events. */
  usageEvents: UsageEventsRepository;
  /** Repository for reading/writing settings (e.g. watermarks). */
  settings: SettingsRepository;
  /** Current timestamp (Unix ms). Injectable for deterministic tests. */
  now: number;
}

// ---------------------------------------------------------------------------
// Collector interface
// ---------------------------------------------------------------------------

/**
 * Contract every usage collector must satisfy.
 *
 * Design invariant: a collector whose `capabilityCheck` returns `ok`
 * but whose `tick` never emits rows within the configured window is
 * automatically downgraded to `unavailable` by the runner. This
 * prevents the "ok with all zeros" forbidden state described in
 * design.md §Collectors — Common Contract.
 */
export interface UsageCollector {
  /** Stable identifier, e.g. 'codex', 'gemini', 'antigravity', 'opencode', 'deepseek'. */
  readonly id: string;

  /**
   * Synchronous or async capability check. Determines whether the
   * collector's data source is reachable and parseable.
   *
   * - `ok`: source found and format recognized
   * - `degraded`: source found but some data may be missing (reason explains)
   * - `unavailable`: source not found or format unrecognized
   * - `disabled`: user has toggled this collector off in settings
   */
  capabilityCheck(): CapabilityResult | Promise<CapabilityResult>;

  /**
   * Perform one scan/collection pass. The collector reads from its
   * data source and writes rows via `ctx.usageEvents.insertIgnore`.
   * Must not throw on recoverable errors (skip bad lines, missing
   * files, etc.); should throw only on truly fatal conditions.
   */
  tick(ctx: UsageCollectorContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runner configuration
// ---------------------------------------------------------------------------

/**
 * Options for the "ok with all zeros" guard and persistence.
 */
export interface RunUsageCollectorOptions {
  /** Repository for persisting the final capability result. */
  settings: SettingsRepository;
  /** Repository for recording collector health (success/failure). */
  collectorHealth: CollectorHealthRepository;
  /** Usage events repository (for row-count check within the window). */
  usageEvents: UsageEventsRepository;
  /**
   * Window duration (ms) within which at least one row must have been
   * emitted for a `status: 'ok'` capability result to remain valid.
   * Defaults to 300_000 (5 minutes).
   */
  emptyWindowMs?: number;
  /** Current timestamp (Unix ms). Defaults to `Date.now()`. */
  now?: number;
}

// ---------------------------------------------------------------------------
// Settings key for persisted capability results
// ---------------------------------------------------------------------------

/** Settings key where last capability results are persisted per collector. */
const DIAGNOSTICS_LAST_CAPABILITY_KEY = 'diagnostics.lastCapability';

// ---------------------------------------------------------------------------
// "ok with all zeros" guard
// ---------------------------------------------------------------------------

/**
 * After a tick where `capabilityCheck` returned `ok`, verify that at
 * least one row was emitted within the configured window. If not,
 * downgrade to `unavailable` with reason.
 *
 * This enforces the design invariant: "ok with all zeros is forbidden."
 */
export function applyEmptyWindowGuard(
  capResult: CapabilityResult,
  collectorId: string,
  opts: RunUsageCollectorOptions,
): CapabilityResult {
  if (capResult.status !== 'ok') {
    return capResult;
  }

  const now = opts.now ?? Date.now();
  const windowMs = opts.emptyWindowMs ?? 300_000;
  const fromTs = now - windowMs;

  // Check if any events were emitted for this provider within the window.
  const aggregate = opts.usageEvents.aggregateForProvider(collectorId, {
    fromTs,
    toTs: now,
  });

  if (aggregate.eventCount === 0) {
    return {
      status: 'unavailable',
      reason: 'ok 但无数据产出',
    };
  }

  return capResult;
}

// ---------------------------------------------------------------------------
// Capability result persistence
// ---------------------------------------------------------------------------

/**
 * Persist the final capability result for a collector into
 * `settings.diagnostics.lastCapability`. The value is a
 * `Record<string, CapabilityResult>` map keyed by collector id.
 */
export function persistCapabilityResult(
  settings: SettingsRepository,
  collectorId: string,
  result: CapabilityResult,
): void {
  const existing =
    settings.get<Record<string, CapabilityResult>>(DIAGNOSTICS_LAST_CAPABILITY_KEY) ?? {};
  existing[collectorId] = result;
  settings.set(DIAGNOSTICS_LAST_CAPABILITY_KEY, existing);
}

/**
 * Read the persisted capability map. Returns an empty object when no
 * data has been stored yet.
 */
export function readCapabilityResults(
  settings: SettingsRepository,
): Record<string, CapabilityResult> {
  return (
    settings.get<Record<string, CapabilityResult>>(DIAGNOSTICS_LAST_CAPABILITY_KEY) ?? {}
  );
}

// ---------------------------------------------------------------------------
// Runner: orchestrates capability check → tick → guard → persist
// ---------------------------------------------------------------------------

/**
 * Run a usage collector through the full lifecycle:
 *
 * 1. Call `capabilityCheck()` — if `unavailable` or `disabled`, skip tick
 * 2. Call `tick(ctx)`
 * 3. Apply the "ok with all zeros" guard
 * 4. Persist the final capability result
 * 5. Record success/failure in collector health
 *
 * Catches all errors and records them as failures; never throws.
 */
export async function runUsageCollector(
  collector: UsageCollector,
  opts: RunUsageCollectorOptions,
): Promise<void> {
  const now = opts.now ?? Date.now();

  let capResult: CapabilityResult;
  try {
    capResult = await collector.capabilityCheck();
  } catch (e) {
    // Capability check itself failed — treat as unavailable.
    const message = e instanceof Error ? e.message : String(e);
    opts.collectorHealth.recordFailure(collector.id, now, message);
    persistCapabilityResult(opts.settings, collector.id, {
      status: 'unavailable',
      reason: `capabilityCheck threw: ${message}`,
    });
    return;
  }

  // If not ok or degraded, skip the tick entirely.
  if (capResult.status === 'unavailable' || capResult.status === 'disabled') {
    persistCapabilityResult(opts.settings, collector.id, capResult);
    // Still record that we ran (but no success).
    opts.collectorHealth.recordFailure(
      collector.id,
      now,
      `skipped: ${capResult.status}${capResult.status === 'unavailable' ? ` (${capResult.reason})` : ''}`,
    );
    return;
  }

  // Capability is ok or degraded — run the tick.
  const ctx: UsageCollectorContext = {
    usageEvents: opts.usageEvents,
    settings: opts.settings,
    now,
  };

  try {
    await collector.tick(ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    opts.collectorHealth.recordFailure(collector.id, now, message);
    persistCapabilityResult(opts.settings, collector.id, capResult);
    return;
  }

  // Apply the "ok with all zeros" guard.
  const finalResult = applyEmptyWindowGuard(capResult, collector.id, opts);

  // Persist and record success.
  persistCapabilityResult(opts.settings, collector.id, finalResult);
  opts.collectorHealth.recordSuccess(collector.id, now);
}
