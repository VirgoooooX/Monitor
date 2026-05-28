// Claude Code collector tests.
//
// Pins the per-line shape we extract from `~/.claude/projects/<ws>/<sid>.jsonl`:
//   - assistant rows with message.usage are billed
//   - cache_read_input_tokens + cache_creation_input_tokens fold into cacheTokens
//   - non-assistant lines (user / permission / hooks) are skipped
//   - lines with all-zero usage are skipped (session bookkeeping)

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createClaudeCodeCollector } from './claudeCode.collector';
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
  bucketsByProviderAndDay: () => never[];
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
      provider: 'claude-code',
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      costUsd: null,
      eventCount: 0,
    }),
    bucketsByProviderAndDay: () => [],
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

async function withTempLayout(
  fileName: string,
  contents: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-test-'));
  const wsDir = path.join(root, 'l--Web-report');
  await fs.promises.mkdir(wsDir, { recursive: true });
  await fs.promises.writeFile(path.join(wsDir, fileName), contents, 'utf-8');
  return {
    root,
    cleanup: async () => {
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

describe('claude-code collector', () => {
  it('extracts per-message usage from assistant rows', async () => {
    const lines = [
      JSON.stringify({
        type: 'last-prompt',
        leafUuid: 'cebf177e-3487-412b-b5ec-5173d46d73d5',
        sessionId: 'e066a55e-35ce-4f4a-9872-bf9967ba6571',
      }),
      JSON.stringify({
        parentUuid: '71c9e72d-e414-40e7-8131-5178b037f408',
        type: 'assistant',
        message: {
          id: 'f4a4b91a-81ca-45eb-b0be-b79e5d2505ec',
          model: 'deepseek-v4-pro',
          usage: {
            input_tokens: 46928,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 1200,
            output_tokens: 141,
          },
        },
        timestamp: '2026-05-08T15:53:34.149Z',
        uuid: 'f18a23c9-2b62-4b46-9fff-8cd579a1ee70',
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'hello' },
      }),
    ];

    const { root, cleanup } = await withTempLayout(
      'session-1.jsonl',
      lines.join('\n') + '\n',
    );
    try {
      const collector = createClaudeCodeCollector({ projectsRoot: root });
      const repo = createMockRepo();
      await collector.tick({
        usageEvents: repo,
        settings: createMockSettings(),
        now: () => Date.now(),
      });

      expect(repo.inserted).toHaveLength(1);
      const row = repo.inserted[0]!;
      expect(row.provider).toBe('claude-code');
      expect(row.model).toBe('deepseek-v4-pro');
      expect(row.inputTokens).toBe(46928);
      expect(row.outputTokens).toBe(141);
      expect(row.cacheTokens).toBe(1200);
      expect(row.eventId).toBe('f18a23c9-2b62-4b46-9fff-8cd579a1ee70');
      expect(row.timestamp).toBe(Date.parse('2026-05-08T15:53:34.149Z'));
    } finally {
      await cleanup();
    }
  });

  it('sums cache_read + cache_creation into cacheTokens', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 7000,
          output_tokens: 80,
        },
      },
      timestamp: '2026-05-27T01:00:00.000Z',
      uuid: 'evt-1',
    });
    const { root, cleanup } = await withTempLayout('s.jsonl', line + '\n');
    try {
      const collector = createClaudeCodeCollector({ projectsRoot: root });
      const repo = createMockRepo();
      await collector.tick({
        usageEvents: repo,
        settings: createMockSettings(),
        now: () => Date.now(),
      });
      expect(repo.inserted).toHaveLength(1);
      expect(repo.inserted[0]!.cacheTokens).toBe(12000);
    } finally {
      await cleanup();
    }
  });

  it('skips zero-usage assistant rows (session bookkeeping)', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
      timestamp: '2026-05-27T01:00:00.000Z',
      uuid: 'evt-bookkeeping',
    });
    const { root, cleanup } = await withTempLayout('s.jsonl', line + '\n');
    try {
      const collector = createClaudeCodeCollector({ projectsRoot: root });
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
});
