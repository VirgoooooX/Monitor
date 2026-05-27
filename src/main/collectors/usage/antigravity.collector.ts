// Antigravity usage collector.
//
// References:
//   - design.md §Property 17
//   - PLAN.md §AI Usage Collectors §Antigravity
//
// Scans `~/.gemini/antigravity` and `%AppData%\Antigravity\logs` for
// log files containing token usage information.
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

import type { CapabilityResult } from '../../types';
import type { UsageCollector, UsageCollectorContext } from './Collector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ANTIGRAVITY_COLLECTOR_ID = 'usage.antigravity';
const PROVIDER = 'antigravity';
const SOURCE = 'antigravity.logs';

const INPUT_TOKEN_FIELDS = ['input_tokens', 'inputTokens', 'prompt_tokens'] as const;
const OUTPUT_TOKEN_FIELDS = ['output_tokens', 'outputTokens', 'completion_tokens'] as const;
const CACHE_TOKEN_FIELDS = ['cache_tokens', 'cacheTokens', 'cached_tokens'] as const;

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface AntigravityCollectorDeps {
  /** Override home-based path for testing. Defaults to `~/.gemini/antigravity`. */
  geminiPath?: string;
  /** Override AppData-based path for testing. Defaults to `%AppData%\Antigravity\logs`. */
  appDataPath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultGeminiPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function getDefaultAppDataPath(): string {
  const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Antigravity', 'logs');
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
 * Find log files (*.jsonl, *.log) in a directory (non-recursive, top level).
 */
async function findLogFiles(dirPath: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.promises.readdir(dirPath);
    for (const entry of entries) {
      if (entry.endsWith('.jsonl') || entry.endsWith('.log')) {
        results.push(path.join(dirPath, entry));
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
 * Create the Antigravity usage collector.
 *
 * Capability check:
 *   1. Look for `~/.gemini/antigravity` dir AND `%AppData%\Antigravity\logs` dir
 *   2. If neither exists → `unavailable` with reason
 *   3. If found, scan for log files with token info; if no token fields → `degraded`
 *
 * Tick:
 *   - Scan log files (JSONL or text), extract tokens using watermark-based
 *     incremental reads identical to the codex collector pattern.
 */
export function createAntigravityCollector(deps?: AntigravityCollectorDeps): UsageCollector {
  const geminiPath = deps?.geminiPath ?? getDefaultGeminiPath();
  const appDataPath = deps?.appDataPath ?? getDefaultAppDataPath();

  return {
    id: ANTIGRAVITY_COLLECTOR_ID,
    provider: PROVIDER,

    async capabilityCheck(): Promise<CapabilityResult> {
      const geminiExists = await directoryExists(geminiPath);
      const appDataExists = await directoryExists(appDataPath);

      if (!geminiExists && !appDataExists) {
        return {
          status: 'unavailable',
          reason: `Antigravity 目录未找到: ${geminiPath} 和 ${appDataPath} 均不存在`,
        };
      }

      // Check for log files with token fields in available directories
      const allLogFiles: string[] = [];
      if (geminiExists) {
        allLogFiles.push(...(await findLogFiles(geminiPath)));
      }
      if (appDataExists) {
        allLogFiles.push(...(await findLogFiles(appDataPath)));
      }

      if (allLogFiles.length === 0) {
        return {
          status: 'degraded',
          reason: '目录存在但未找到可解析的日志文件',
        };
      }

      // Probe a sample of files for token fields
      let foundTokens = false;
      for (const file of allLogFiles.slice(0, 5)) {
        try {
          const content = await fs.promises.readFile(file, 'utf-8');
          const lines = content.split('\n').slice(0, 20); // sample first 20 lines
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
          status: 'degraded',
          reason: '日志文件存在但未找到 token 字段',
        };
      }

      return { status: 'ok' };
    },

    async tick(ctx: UsageCollectorContext): Promise<void> {
      // Gather all log files from both directories
      const allLogFiles: string[] = [];

      if (await directoryExists(geminiPath)) {
        allLogFiles.push(...(await findLogFiles(geminiPath)));
      }
      if (await directoryExists(appDataPath)) {
        allLogFiles.push(...(await findLogFiles(appDataPath)));
      }

      for (const filePath of allLogFiles) {
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
