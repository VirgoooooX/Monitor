// Usage collector tests.
//
// Covers:
//   - applyEmptyWindowGuard downgrades "ok" to "unavailable" when no events
//   - applyEmptyWindowGuard preserves "ok" when events exist
//   - persistCapabilityResult stores results correctly
//   - Disabled collectors persist 'disabled' status

import { describe, it, expect } from 'vitest';
import {
  applyEmptyWindowGuard,
  persistCapabilityResult,
  readCapabilityResults,
} from './Collector';
import type { CapabilityResult } from '../../types';

// ---------------------------------------------------------------------------
// In-memory mock repositories
// ---------------------------------------------------------------------------

function createMockSettings() {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      store.set(key, value);
    },
    remove(key: string): void {
      store.delete(key);
    },
    keys(): string[] {
      return Array.from(store.keys());
    },
    entries(): Array<{ key: string; value: unknown }> {
      return Array.from(store.entries()).map(([key, value]) => ({ key, value }));
    },
  };
}

function createMockUsageEvents(eventCount = 0) {
  return {
    insertIgnore: () => true,
    watermark: () => null,
    aggregateByProvider: () => [],
    aggregateForProvider: () => ({
      provider: 'test',
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      costUsd: null,
      eventCount,
    }),
    recentForProvider: () => [],
  };
}

function createMockCollectorHealth() {
  const records: Array<{ collector: string; at: number; error?: string }> = [];
  return {
    upsert: () => {},
    recordSuccess: (collector: string, at: number) => {
      records.push({ collector, at });
    },
    recordFailure: (collector: string, at: number, error: string) => {
      records.push({ collector, at, error });
    },
    get: () => undefined,
    list: () => [],
    _records: records,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyEmptyWindowGuard', () => {
  it('downgrades ok to unavailable when no events in window', () => {
    const settings = createMockSettings();
    const usageEvents = createMockUsageEvents(0); // no events
    const collectorHealth = createMockCollectorHealth();

    const result = applyEmptyWindowGuard(
      { status: 'ok' },
      'codex',
      { settings, usageEvents, collectorHealth, now: Date.now() },
    );

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toContain('无数据');
    }
  });

  it('preserves ok when events exist in window', () => {
    const settings = createMockSettings();
    const usageEvents = createMockUsageEvents(5); // has events
    const collectorHealth = createMockCollectorHealth();

    const result = applyEmptyWindowGuard(
      { status: 'ok' },
      'codex',
      { settings, usageEvents, collectorHealth, now: Date.now() },
    );

    expect(result.status).toBe('ok');
  });

  it('does not modify non-ok results', () => {
    const settings = createMockSettings();
    const usageEvents = createMockUsageEvents(0);
    const collectorHealth = createMockCollectorHealth();

    const degraded: CapabilityResult = { status: 'degraded', reason: 'partial' };
    const result = applyEmptyWindowGuard(
      degraded,
      'gemini',
      { settings, usageEvents, collectorHealth, now: Date.now() },
    );

    expect(result).toEqual(degraded);
  });
});

describe('persistCapabilityResult / readCapabilityResults', () => {
  it('persists and reads capability results', () => {
    const settings = createMockSettings();

    persistCapabilityResult(settings, 'codex', { status: 'ok' });
    persistCapabilityResult(settings, 'gemini', { status: 'disabled' });

    const results = readCapabilityResults(settings);
    expect(results['codex']).toEqual({ status: 'ok' });
    expect(results['gemini']).toEqual({ status: 'disabled' });
  });

  it('overwrites previous result for same collector', () => {
    const settings = createMockSettings();

    persistCapabilityResult(settings, 'codex', { status: 'ok' });
    persistCapabilityResult(settings, 'codex', { status: 'unavailable', reason: 'gone' });

    const results = readCapabilityResults(settings);
    expect(results['codex']).toEqual({ status: 'unavailable', reason: 'gone' });
  });

  it('returns empty object when nothing stored', () => {
    const settings = createMockSettings();
    const results = readCapabilityResults(settings);
    expect(results).toEqual({});
  });
});
