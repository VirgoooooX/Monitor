// Kiro collector tests.
//
// Pins the per-line shape we extract from
// `tokens_generated.jsonl` — `promptTokens` → input,
// `generatedTokens` → output. Watermarking is exercised by
// running tick twice against the same file and asserting only
// new lines are inserted on the second pass.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createKiroCollector } from './kiro.collector';
import type { UsageEventInsert } from '../../store/repositories';

interface MockRepo {
  inserted: UsageEventInsert[];
  insertIgnore: (event: UsageEventInsert) => boolean;
  watermark: () => number | null;
  aggregateByProvider: () => never[];
  aggregateForProvider: () => {
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number | null;
    eventCount: number;
  };
  recentForProvider: () => never[];
}

function createMockRepo(initialWatermark: number | null = null): MockRepo {
  const inserted: UsageEventInsert[] = [];
  let highWatermark = initialWatermark;
  return {
    inserted,
    insertIgnore: (event) => {
      inserted.push(event);
      if (highWatermark === null || event.sourceOffset > highWatermark) {
        highWatermark = event.sourceOffset;
      }
      return true;
    },
    watermark: () => highWatermark,
    aggregateByProvider: () => [],
    aggregateForProvider: () => ({
      provider: 'kiro-ide',
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      costUsd: null,
      eventCount: 0,
    }),
    recentForProvider: () => [],
  };
}

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

async function writeTempLog(contents: string): Promise<{ logPath: string; cleanup: () => Promise<void> }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kiro-test-'));
  const logPath = path.join(root, 'tokens_generated.jsonl');
  await fs.promises.writeFile(logPath, contents, 'utf-8');
  return {
    logPath,
    cleanup: async () => {
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

describe('kiro collector', () => {
  it('maps promptTokens / generatedTokens to input / output', async () => {
    const lines = [
      JSON.stringify({ model: 'agent', provider: 'kiro', promptTokens: 4520, generatedTokens: 0 }),
      JSON.stringify({ model: 'agent', provider: 'kiro', promptTokens: 6074, generatedTokens: 12 }),
    ];
    const { logPath, cleanup } = await writeTempLog(lines.join('\n') + '\n');
    try {
      const collector = createKiroCollector({ logPath });
      const repo = createMockRepo();
      await collector.tick({
        usageEvents: repo,
        settings: createMockSettings(),
        now: () => 1700000000000,
      });
      expect(repo.inserted).toHaveLength(2);
      expect(repo.inserted[0]!.inputTokens).toBe(4520);
      expect(repo.inserted[0]!.outputTokens).toBe(0);
      expect(repo.inserted[1]!.inputTokens).toBe(6074);
      expect(repo.inserted[1]!.outputTokens).toBe(12);
      expect(repo.inserted[0]!.provider).toBe('kiro-ide');
    } finally {
      await cleanup();
    }
  });

  it('skips lines with all zero counters', async () => {
    const line = JSON.stringify({ model: 'agent', provider: 'kiro', promptTokens: 0, generatedTokens: 0 });
    const { logPath, cleanup } = await writeTempLog(line + '\n');
    try {
      const collector = createKiroCollector({ logPath });
      const repo = createMockRepo();
      await collector.tick({
        usageEvents: repo,
        settings: createMockSettings(),
        now: () => 1700000000000,
      });
      expect(repo.inserted).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('only reads new lines on subsequent tick (watermark)', async () => {
    const initial = JSON.stringify({ model: 'agent', provider: 'kiro', promptTokens: 100, generatedTokens: 5 });
    const { logPath, cleanup } = await writeTempLog(initial + '\n');
    try {
      const collector = createKiroCollector({ logPath });
      const repo = createMockRepo();
      const settings = createMockSettings();

      await collector.tick({
        usageEvents: repo,
        settings,
        now: () => 1700000000000,
      });
      expect(repo.inserted).toHaveLength(1);

      // Append a new line and tick again.
      const next = JSON.stringify({ model: 'agent', provider: 'kiro', promptTokens: 200, generatedTokens: 10 });
      await fs.promises.appendFile(logPath, next + '\n', 'utf-8');

      await collector.tick({
        usageEvents: repo,
        settings,
        now: () => 1700000000001,
      });
      expect(repo.inserted).toHaveLength(2);
      expect(repo.inserted[1]!.inputTokens).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('reports unavailable when log file does not exist', async () => {
    const collector = createKiroCollector({
      logPath: path.join(os.tmpdir(), 'definitely-not-real-kiro-' + Date.now() + '.jsonl'),
    });
    const result = await collector.capabilityCheck();
    expect(result.status).toBe('unavailable');
  });
});
