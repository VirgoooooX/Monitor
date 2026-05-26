// Usage collector common interface and context.
//
// References:
//   - design.md §Collectors — Common Contract
//   - PLAN.md §AI Usage Collectors 通用约定
//
// This file defines the shared contract that every usage collector
// (Codex, Gemini, Antigravity, OpenCode, DeepSeek) must implement.
// The `UsageCollector` interface extends the abstract `Collector`
// concept from design.md with usage-specific context.

import type { CapabilityResult } from '../../types';
import type { UsageEventsRepository } from '../../store/repositories';

/**
 * Context injected into every usage collector `tick`. Kept minimal so
 * collectors remain testable without wiring the full app.
 */
export interface UsageCollectorContext {
  /** The usage_events repository for INSERT OR IGNORE writes. */
  usageEvents: UsageEventsRepository;
  /** Wall clock; defaults to `Date.now` in production. */
  now: () => number;
}

/**
 * Common contract for all AI-usage collectors.
 *
 * Each collector:
 *   - has a stable `id` (e.g. `'usage.codex'`)
 *   - performs a `capabilityCheck` to determine if its data source is
 *     available / degraded / unavailable / disabled
 *   - runs a `tick` that scans its data source and inserts new usage
 *     events into the DB via INSERT OR IGNORE
 */
export interface UsageCollector {
  /** Stable identifier used in scheduler and collector_health. */
  readonly id: string;

  /**
   * Probe the data source to determine if it's usable.
   * Must not throw; returns a typed result instead.
   */
  capabilityCheck(): Promise<CapabilityResult>;

  /**
   * Perform one scan of the data source. Must not throw on corrupt or
   * missing data; instead skip bad records silently and only throw on
   * truly fatal errors (e.g. DB write failure).
   */
  tick(ctx: UsageCollectorContext): Promise<void>;
}
