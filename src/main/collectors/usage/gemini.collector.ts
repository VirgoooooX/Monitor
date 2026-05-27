// Gemini CLI usage collector.
//
// References:
//   - design.md §Gemini CLI Usage Scan
//   - PLAN.md §AI Usage Collectors §Gemini CLI
//
// Scans `~/.gemini/history` for session history files (JSON/JSONL).
// Gemini CLI typically does NOT include token usage fields in its
// history files, so this collector commonly operates in `degraded`
// mode — still emitting events (with zero tokens) to track session
// count and last activity time in the dashboard.
//
// Deduplication is guaranteed by the UNIQUE(provider, source_path,
// source_offset) constraint. `source_offset` is the byte offset at the
// start of each line/entry, making it a deterministic dedup key.
//
// Privacy:
//   - NEVER stores prompt, response, cookies, or authorization headers.
//   - Only extracts: timestamp, model (if present), token counts (if present),
//     event_id (if present).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CapabilityResult } from '../../types';
import type { UsageCollector, UsageCollectorContext } from './Collector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GEMINI_COLLECTOR_ID = 'usage.gemini-cli';
const PROVIDER = 'gemini-cli';
const SOURCE = 'gemini.history';

/** Reason surfaced when history files lack token usage fields. */
const DEGRADED_REASON =
  'Gemini CLI 历史文件不包含 token 用量字段, 仅记录会话数和最后 activity 时间';

/**
 * Fields we look for in each record to extract token counts.
 */
const INPUT_TOKEN_FIELDS = ['input_tokens', 'inputTokens', 'prompt_tokens'] as const;
const OUTPUT_TOKEN_FIELDS = ['output_tokens', 'outputTokens', 'completion_tokens'] as const;
const CACHE_TOKEN_FIELDS = ['cache_tokens', 'cacheTokens', 'cached_tokens'] as const;

/**
 * Fields that MUST NOT be stored. We strip these from consideration
 * to ensure no sensitive content leaks into usage_events.
 */
const FORBIDDEN_FIELDS = new Set([
  'prompt', 'response', 'messages', 'content',
  'cookie', 'cookies', 'authorization', 'auth',
  'api_key', 'apiKey', 'secret', 'token',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the Gemini CLI history directory. */
function getGeminiHistoryRoot(): string {
  return path.join(os.homedir(), '.gemini', 'history');
}

/**
 * Recursively find all JSON/JSONL files under the history directory.
 */
async function findHistoryFiles(historyRoot: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))
      ) {
        results.push(fullPath);
      }
    }
  }

  await walk(historyRoot);
  return results;
}

/**
 * Safely parse a JSON line. Returns null on any parse error.
 */
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

/**
 * Extract the first matching numeric field from a record using
 * a list of candidate field names.
 */
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

/**
 * Check if a record contains any token-bearing field with non-zero value.
 */
function hasTokenFields(record: Record<string, unknown>): boolean {
  const input = extractNumericField(record, INPUT_TOKEN_FIELDS);
  const output = extractNumericField(record, OUTPUT_TOKEN_FIELDS);
  const cache = extractNumericField(record, CACHE_TOKEN_FIELDS);
  return input > 0 || output > 0 || cache > 0;
}

/**
 * Extract a timestamp from the record. Looks for common timestamp
 * fields and returns epoch ms.
 */
function extractTimestamp(record: Record<string, unknown>, fallback: number): number {
  const candidates = ['timestamp', 'ts', 'created_at', 'time', 'created', 'date'];
  for (const field of candidates) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      // If value looks like seconds (< 1e12), convert to ms
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

/**
 * Extract a model name from the record, if present.
 */
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

/**
 * Extract an event ID from the record, if present.
 */
function extractEventId(record: Record<string, unknown>): string | null {
  const candidates = ['id', 'event_id', 'eventId', 'request_id', 'requestId', 'session_id'];
  for (const field of candidates) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      if (!FORBIDDEN_FIELDS.has(field)) {
        return value;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Collector implementation
// ---------------------------------------------------------------------------

export interface GeminiCollectorDeps {
  /** Override the history root for testing. Defaults to `~/.gemini/history`. */
  historyRoot?: string;
}

/**
 * Create the Gemini CLI usage collector.
 *
 * The collector:
 *   1. Scans `~/.gemini/history` for .json/.jsonl files
 *   2. For each file, queries the watermark (MAX source_offset)
 *   3. Reads the file from the watermark byte offset onward
 *   4. Parses each JSON line, extracts token counts (if available)
 *   5. Inserts via INSERT OR IGNORE (dedup by source_offset)
 *   6. In degraded mode (no token fields): emits events with 0 tokens
 *      to track session count and last activity
 */
export function createGeminiCollector(deps?: GeminiCollectorDeps): UsageCollector {
  const historyRoot = deps?.historyRoot ?? getGeminiHistoryRoot();

  /** Track whether any file contained token fields during the last tick. */
  let lastTickHadTokens = false;

  return {
    id: GEMINI_COLLECTOR_ID,
    provider: PROVIDER,

    async capabilityCheck(): Promise<CapabilityResult> {
      // Check if history directory exists and is readable
      try {
        await fs.promises.access(historyRoot, fs.constants.R_OK);
      } catch {
        return {
          status: 'unavailable',
          reason: `Gemini CLI history directory not found: ${historyRoot}`,
        };
      }

      // Check if there are any history files
      const files = await findHistoryFiles(historyRoot);
      if (files.length === 0) {
        return {
          status: 'unavailable',
          reason: 'No history files found in Gemini CLI history directory',
        };
      }

      // Sample the first file to see if it has token fields
      const sampleFile = files[0]!;
      try {
        const content = await fs.promises.readFile(sampleFile, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim().length > 0);

        let foundTokens = false;
        for (const line of lines.slice(0, 20)) {
          const record = parseJsonLine(line);
          if (record && hasTokenFields(record)) {
            foundTokens = true;
            break;
          }
        }

        if (!foundTokens) {
          // Common case for Gemini CLI: history exists but no token data
          return {
            status: 'degraded',
            reason: DEGRADED_REASON,
          };
        }
      } catch {
        // Could not read sample file — still degraded since dir exists
        return {
          status: 'degraded',
          reason: 'Gemini CLI history directory exists but files could not be sampled',
        };
      }

      return { status: 'ok' };
    },

    async tick(ctx: UsageCollectorContext): Promise<void> {
      const files = await findHistoryFiles(historyRoot);
      lastTickHadTokens = false;

      for (const filePath of files) {
        const normalizedPath = path.normalize(filePath);

        // Get the watermark (last known byte offset for this file)
        const watermark =
          ctx.usageEvents.watermark(PROVIDER, normalizedPath) ?? -1;
        const startOffset = watermark + 1;

        // Read the file content
        let content: Buffer;
        try {
          content = await fs.promises.readFile(filePath);
        } catch {
          // File disappeared or became unreadable
          continue;
        }

        // If we've already read past the end, skip
        if (startOffset >= content.length) {
          continue;
        }

        // Parse lines from the watermark offset onward
        let currentOffset = startOffset;
        const slice = content.slice(startOffset);
        const text = slice.toString('utf-8');
        const lines = text.split('\n');

        for (const line of lines) {
          const lineByteLength = Buffer.byteLength(line, 'utf-8');
          const lineStartOffset = currentOffset;

          // Move offset past this line + the newline character
          currentOffset += lineByteLength + 1;

          // Skip empty lines
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }

          // Parse the JSON line
          const record = parseJsonLine(trimmed);
          if (record === null) {
            // Corrupt line — skip silently
            continue;
          }

          // Extract fields (NEVER store prompt/response/cookies/auth)
          const timestamp = extractTimestamp(record, ctx.now());
          const model = extractModel(record);
          const eventId = extractEventId(record);

          let inputTokens = 0;
          let outputTokens = 0;
          let cacheTokens = 0;

          if (hasTokenFields(record)) {
            // Token fields available — extract them
            inputTokens = extractNumericField(record, INPUT_TOKEN_FIELDS);
            outputTokens = extractNumericField(record, OUTPUT_TOKEN_FIELDS);
            cacheTokens = extractNumericField(record, CACHE_TOKEN_FIELDS);
            lastTickHadTokens = true;
          }
          // In degraded mode (no token fields): still emit with 0 tokens
          // so we can track session count and last activity

          // Insert with dedup via UNIQUE(provider, source_path, source_offset)
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
