// OpenCode usage collector.
//
// References:
//   - design.md §Property 17
//   - PLAN.md §AI Usage Collectors §OpenCode
//
// Scans `%AppData%\opencode` for structured logs containing token usage.
//
// Privacy:
//   - NEVER stores prompts, responses, cookies, or authorization headers.
//   - Only extracts: timestamp, model, input_tokens, output_tokens,
//     cache_tokens, event_id.
//
// Default: disabled in settings.collectors.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveOpencodePath, type ResolverEnv } from '../../platform/paths';
import type { CapabilityResult } from '../../types';
import type { UsageCollector, UsageCollectorContext } from './Collector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPENCODE_COLLECTOR_ID = 'usage.opencode';
const PROVIDER = 'opencode';
const SOURCE = 'opencode.logs';

const INPUT_TOKEN_FIELDS = ['input_tokens', 'inputTokens', 'prompt_tokens'] as const;
const OUTPUT_TOKEN_FIELDS = ['output_tokens', 'outputTokens', 'completion_tokens'] as const;
const CACHE_TOKEN_FIELDS = ['cache_tokens', 'cacheTokens', 'cached_tokens'] as const;

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface OpenCodeCollectorDeps {
  /**
   * Override the opencode directory for testing. When provided as a
   * non-empty string, the per-platform resolver is bypassed entirely
   * and this value is used verbatim as the resolved log directory
   * (Requirement 4.6).
   *
   * Defaults to the value computed by `resolveOpencodePath` for the
   * current `process.platform` / `process.env` / `os.homedir()`.
   */
  opencodePath?: string;
  /**
   * Test-only override for `process.platform`. Lets tests fix the
   * resolver branch without monkey-patching the global
   * `process.platform`. Ignored when `opencodePath` is supplied.
   */
  platform?: string;
  /**
   * Test-only override for `process.env`. The resolver only reads
   * `APPDATA` and `XDG_DATA_HOME` from this slice. Ignored when
   * `opencodePath` is supplied.
   */
  env?: ResolverEnv;
  /**
   * Test-only override for `os.homedir()`. Ignored when
   * `opencodePath` is supplied.
   */
  homedir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultOpencodePath(
  platform: string,
  env: ResolverEnv,
  homedir: string,
): string {
  return resolveOpencodePath(platform, env, homedir);
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find structured log files (*.jsonl, *.json, *.log) in a directory.
 */
async function findLogFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.jsonl' || ext === '.json' || ext === '.log') {
          results.push(path.join(dirPath, entry.name));
        }
      } else if (entry.isDirectory()) {
        // Check one level of subdirectories (e.g. sessions/)
        try {
          const subEntries = await fs.promises.readdir(
            path.join(dirPath, entry.name),
          );
          for (const subEntry of subEntries) {
            const subExt = path.extname(subEntry).toLowerCase();
            if (subExt === '.jsonl' || subExt === '.json' || subExt === '.log') {
              results.push(path.join(dirPath, entry.name, subEntry));
            }
          }
        } catch {
          // Subdirectory unreadable
        }
      }
    }
  } catch {
    // Directory unreadable
  }
  return results;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractNumericField(
  record: Record<string, unknown>,
  candidates: readonly string[],
): number {
  for (const field of candidates) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return 0;
}

function hasTokenFields(record: Record<string, unknown>): boolean {
  const input = extractNumericField(record, INPUT_TOKEN_FIELDS);
  const output = extractNumericField(record, OUTPUT_TOKEN_FIELDS);
  const cache = extractNumericField(record, CACHE_TOKEN_FIELDS);
  return input > 0 || output > 0 || cache > 0;
}

function extractTimestamp(record: Record<string, unknown>, fallback: number): number {
  const candidates = ['timestamp', 'ts', 'created_at', 'time', 'created'];
  for (const field of candidates) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return fallback;
}

function extractModel(record: Record<string, unknown>): string | null {
  const candidates = ['model', 'model_name', 'modelName'];
  for (const field of candidates) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function extractEventId(record: Record<string, unknown>): string | null {
  const candidates = ['id', 'event_id', 'eventId', 'request_id', 'requestId'];
  for (const field of candidates) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Collector implementation
// ---------------------------------------------------------------------------

/**
 * Create the OpenCode usage collector.
 *
 * Capability check:
 *   1. Look for `%AppData%\opencode` dir
 *   2. If not found → `unavailable` with reason
 *   3. If found but no structured token field in logs → `unavailable + "无可解析 token 字段"`
 *
 * Tick:
 *   - Scan structured logs if available, using watermark-based incremental reads.
 */
export function createOpenCodeCollector(deps?: OpenCodeCollectorDeps): UsageCollector {
  // Resolve the path exactly once at collector construction. The
  // resulting absolute string is closed over by `capabilityCheck`
  // and `tick`, so the per-platform branch is never re-evaluated
  // per cycle (Requirement 4.1).
  //
  // The override semantics are: a non-empty `deps.opencodePath`
  // bypasses the platform resolver entirely (Requirement 4.6); any
  // other case (omitted, undefined, empty string) falls through to
  // `resolveOpencodePath` with either the test-injected
  // platform/env/homedir slice or the live globals.
  const override =
    typeof deps?.opencodePath === 'string' && deps.opencodePath.length > 0
      ? deps.opencodePath
      : undefined;
  const opencodePath =
    override ??
    getDefaultOpencodePath(
      deps?.platform ?? process.platform,
      deps?.env ?? (process.env as ResolverEnv),
      deps?.homedir ?? os.homedir(),
    );

  return {
    id: OPENCODE_COLLECTOR_ID,
    provider: PROVIDER,

    async capabilityCheck(): Promise<CapabilityResult> {
      const exists = await directoryExists(opencodePath);

      if (!exists) {
        return {
          status: 'unavailable',
          reason: `OpenCode 目录未找到: ${opencodePath}`,
        };
      }

      // Look for structured log files
      const logFiles = await findLogFiles(opencodePath);

      if (logFiles.length === 0) {
        return {
          status: 'unavailable',
          reason: '无可解析 token 字段',
        };
      }

      // Probe files for token fields
      let foundTokens = false;
      for (const file of logFiles.slice(0, 5)) {
        try {
          const content = await fs.promises.readFile(file, 'utf-8');
          const lines = content.split('\n').slice(0, 20);
          for (const line of lines) {
            const record = parseJsonLine(line.trim());
            if (record && hasTokenFields(record)) {
              foundTokens = true;
              break;
            }
          }
          if (foundTokens) break;
        } catch {
          continue;
        }
      }

      if (!foundTokens) {
        return {
          status: 'unavailable',
          reason: '无可解析 token 字段',
        };
      }

      return { status: 'ok' };
    },

    async tick(ctx: UsageCollectorContext): Promise<void> {
      if (!(await directoryExists(opencodePath))) return;

      const logFiles = await findLogFiles(opencodePath);

      for (const filePath of logFiles) {
        const normalizedPath = path.normalize(filePath);

        // Watermark-based incremental read
        const watermark = ctx.usageEvents.watermark(PROVIDER, normalizedPath) ?? -1;
        const startOffset = watermark + 1;

        let content: Buffer;
        try {
          content = await fs.promises.readFile(filePath);
        } catch {
          continue;
        }

        if (startOffset >= content.length) {
          continue;
        }

        let currentOffset = startOffset;
        const slice = content.slice(startOffset);
        const text = slice.toString('utf-8');
        const lines = text.split('\n');

        for (const line of lines) {
          const lineByteLength = Buffer.byteLength(line, 'utf-8');
          const lineStartOffset = currentOffset;
          currentOffset += lineByteLength + 1;

          const trimmed = line.trim();
          if (trimmed.length === 0) continue;

          const record = parseJsonLine(trimmed);
          if (record === null) continue;
          if (!hasTokenFields(record)) continue;

          const inputTokens = extractNumericField(record, INPUT_TOKEN_FIELDS);
          const outputTokens = extractNumericField(record, OUTPUT_TOKEN_FIELDS);
          const cacheTokens = extractNumericField(record, CACHE_TOKEN_FIELDS);
          const timestamp = extractTimestamp(record, ctx.now());
          const model = extractModel(record);
          const eventId = extractEventId(record);

          ctx.usageEvents.insertIgnore({
            timestamp,
            provider: PROVIDER,
            model,
            inputTokens,
            outputTokens,
            cacheTokens,
            costUsd: null,
            source: SOURCE,
            sourcePath: normalizedPath,
            sourceOffset: lineStartOffset,
            eventId,
          });
        }
      }
    },
  };
}
