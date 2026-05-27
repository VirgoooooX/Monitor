// Codex collector — token extraction tests.
//
// Covers the nested Codex desktop schema:
//   payload.type === 'token_count'
//   payload.info.last_token_usage / total_token_usage
//
// The collector previously only handled top-level `input_tokens`
// fields, which never matched the real Codex shape, so the
// `usage_events` table stayed empty and the renderer rendered
// "暂无 Token 记录". These tests pin the new extractor's behavior.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCodexCollector } from './codex.collector';
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

function createMockRepo(): MockRepo {
  const inserted: UsageEventInsert[] = [];
  return {
    inserted,
    insertIgnore: (event) => {
      inserted.push(event);
      return true;
    },
    watermark: () => null,
    aggregateByProvider: () => [],
    aggregateForProvider: () => ({
      provider: 'codex',
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

async function withTempCodexLayout(
  fileContents: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-test-'));
  const dayDir = path.join(root, '2026', '05', '27');
  await fs.promises.mkdir(dayDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dayDir, 'rollout-test.jsonl'),
    fileContents,
    'utf-8',
  );
  return {
    root,
    cleanup: async () => {
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

describe('codex collector — nested token_count payload', () => {
  it('extracts input/output/cache tokens from payload.info.last_token_usage', async () => {
    const realCodexLine = JSON.stringify({
      timestamp: '2026-05-27T13:03:07.576Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 17464,
            cached_input_tokens: 6016,
            output_tokens: 258,
            reasoning_output_tokens: 92,
            total_tokens: 17722,
          },
          last_token_usage: {
            input_tokens: 17464,
            cached_input_tokens: 6016,
            output_tokens: 258,
            reasoning_output_tokens: 92,
            total_tokens: 17722,
          },
          model_context_window: 258400,
        },
      },
    });

    const { root, cleanup } = await withTempCodexLayout(realCodexLine + '\n');
    try {
      const collector = createCodexCollector({
        sessionsRoot: root,
        logsDbPath: path.join(root, 'logs_2.sqlite'),
      });
      const repo = createMockRepo();
      await collector.tick({
        usageEvents: repo,
        settings: createMockSettings(),
        now: () => Date.now(),
      });

      expect(repo.inserted).toHaveLength(1);
      const row = repo.inserted[0]!;
      expect(row.provider).toBe('codex');
      expect(row.inputTokens).toBe(17464);
      // output_tokens(258) + reasoning_output_tokens(92) — billed together.
      expect(row.outputTokens).toBe(350);
      expect(row.cacheTokens).toBe(6016);
    } finally {
      await cleanup();
    }
  });

  it('skips lines that are not token_count events', async () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-05-27T13:02:55.747Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: '019e6987-d708-79d1-b736-86c6b33f08de',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-27T13:02:55.843Z',
        type: 'response_item',
        payload: { type: 'message', role: 'developer' },
      }),
    ];

    const { root, cleanup } = await withTempCodexLayout(lines.join('\n') + '\n');
    try {
      const collector = createCodexCollector({
        sessionsRoot: root,
        logsDbPath: path.join(root, 'logs_2.sqlite'),
      });
      const repo = createMockRepo();
      await collector.tick({
        usageEvents: repo,
        settings: createMockSettings(),
        now: () => Date.now(),
      });
      expect(repo.inserted).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('falls back to total_token_usage when last_token_usage is missing', async () => {
    const line = JSON.stringify({
      timestamp: '2026-05-27T13:03:07.576Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 50,
            cached_input_tokens: 10,
          },
        },
      },
    });

    const { root, cleanup } = await withTempCodexLayout(line + '\n');
    try {
      const collector = createCodexCollector({
        sessionsRoot: root,
        logsDbPath: path.join(root, 'logs_2.sqlite'),
      });
      const repo = createMockRepo();
      await collector.tick({
        usageEvents: repo,
        settings: createMockSettings(),
        now: () => Date.now(),
      });
      expect(repo.inserted).toHaveLength(1);
      expect(repo.inserted[0]!.inputTokens).toBe(100);
      expect(repo.inserted[0]!.outputTokens).toBe(50);
      expect(repo.inserted[0]!.cacheTokens).toBe(10);
    } finally {
      await cleanup();
    }
  });

  it('still handles legacy flat shape (top-level input_tokens)', async () => {
    const line = JSON.stringify({
      timestamp: '2026-01-01T00:00:00Z',
      input_tokens: 42,
      output_tokens: 7,
      cache_tokens: 3,
      model: 'codex-legacy',
    });

    const { root, cleanup } = await withTempCodexLayout(line + '\n');
    try {
      const collector = createCodexCollector({
        sessionsRoot: root,
        logsDbPath: path.join(root, 'logs_2.sqlite'),
      });
      const repo = createMockRepo();
      await collector.tick({
        usageEvents: repo,
        settings: createMockSettings(),
        now: () => Date.now(),
      });
      expect(repo.inserted).toHaveLength(1);
      expect(repo.inserted[0]!.inputTokens).toBe(42);
      expect(repo.inserted[0]!.outputTokens).toBe(7);
      expect(repo.inserted[0]!.cacheTokens).toBe(3);
      expect(repo.inserted[0]!.model).toBe('codex-legacy');
    } finally {
      await cleanup();
    }
  });
});
