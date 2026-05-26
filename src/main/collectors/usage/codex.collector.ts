// Codex JSONL usage collector.
//
// References:
//   - design.md §Codex Usage Scan, §Property 5, §Property 6, §Property 16
//   - PLAN.md §AI Usage Collectors §Codex
//
// Scans `~/.codex/sessions/YYYY/MM/DD/*.jsonl` files for token usage
// events. Each file is append-only; the collector reads from the last
// known byte offset (watermark) and emits one `INSERT OR IGNORE` per
// valid line containing token fields.
//
// Deduplication is guaranteed by the UNIQUE(provider, source_path,
// source_offset) constraint. `source_offset` is the byte offset at the
// start of each line, making it a deterministic dedup key that survives
// re-reads of the same file.
//
// Privacy:
//   - NEVER stores prompt, response, cookies, or authorization headers.
//   - Only extracts: timestamp, model, input_tokens, output_tokens,
//     cache_tokens, event_id.
//
// External SQLite (logs_2.sqlite):
//   - Opened with `{ readonly: true, fileMustExist: true }` to avoid
//     creating WAL/SHM files that could disrupt the producing process.
//   - If no stable token field is found, marks capability as `degraded`.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CapabilityResult } from '../../types';
import { openExternalReadonly, ExternalDatabaseUnavailableError } from '../../store/db';
import type { UsageCollector, UsageCollectorContext } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CODEX_COLLECTOR_ID = 'usage.codex';
const PROVIDER = 'codex';
const SOURCE = 'codex.jsonl';

/**
 * Fields we look for in each JSONL record to extract token counts.
 * Codex may use different naming conventions across versions.
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

/** Resolve the Codex sessions root directory. */
function getCodexSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/** Resolve the Codex logs_2.sqlite path. */
function getCodexLogsDbPath(): string {
  return path.join(os.homedir(), '.codex', 'logs_2.sqlite');
}

/**
 * Recursively find all .jsonl files under the sessions directory.
 * Structure: sessions/YYYY/MM/DD/*.jsonl
 */
async function findJsonlFiles(sessionsRoot: string): Promise<string[]> {
  const results: string[] = [];

  try {
    const years = await fs.promises.readdir(sessionsRoot);
    for (const year of years) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearPath = path.join(sessionsRoot, year);

      let months: string[];
      try {
        months = await fs.promises.readdir(yearPath);
      } catch {
        continue;
      }

      for (const month of months) {
        if (!/^\d{2}$/.test(month)) continue;
        const monthPath = path.join(yearPath, month);

        let days: string[];
        try {
          days = await fs.promises.readdir(monthPath);
        } catch {
          continue;
        }

        for (const day of days) {
          if (!/^\d{2}$/.test(day)) continue;
          const dayPath = path.join(monthPath, day);

          let files: string[];
          try {
            files = await fs.promises.readdir(dayPath);
          } catch {
            continue;
          }

          for (const file of files) {
            if (file.endsWith('.jsonl')) {
              results.push(path.join(dayPath, file));
            }
          }
        }
      }
    }
  } catch {
    // sessionsRoot doesn't exist or isn't readable
  }

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
 * Check if a record contains any token-bearing field. A line must have
 * at least one non-zero token count to be considered valid.
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
  const candidates = ['timestamp', 'ts', 'created_at', 'time', 'created'];
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
  const candidates = ['id', 'event_id', 'eventId', 'request_id', 'requestId'];
  for (const field of candidates) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      // Ensure the id field is not in the forbidden set
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

export interface CodexCollectorDeps {
  /** Override the sessions root for testing. Defaults to `~/.codex/sessions`. */
  sessionsRoot?: string;
  /** Override the logs_2.sqlite path for testing. */
  logsDbPath?: string;
}

/**
 * Create the Codex JSONL usage collector.
 *
 * The collector:
 *   1. Globs `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
 *   2. For each file, queries the watermark (MAX source_offset)
 *   3. Reads the file from the watermark byte offset onward
 *   4. Parses each JSON line, extracts token counts
 *   5. Inserts via INSERT OR IGNORE (dedup by source_offset)
 *   6. Skips corrupt lines and lines without token fields silently
 */
export function createCodexCollector(deps?: CodexCollectorDeps): UsageCollector {
  const sessionsRoot = deps?.sessionsRoot ?? getCodexSessionsRoot();
  const logsDbPath = deps?.logsDbPath ?? getCodexLogsDbPath();

  return {
    id: CODEX_COLLECTOR_ID,

    async capabilityCheck(): Promise<CapabilityResult> {
      // Check if sessions directory exists
      try {
        await fs.promises.access(sessionsRoot, fs.constants.R_OK);
      } catch {
        return {
          status: 'unavailable',
          reason: `Codex sessions directory not found: ${sessionsRoot}`,
        };
      }

      // Check if there are any .jsonl files
      const files = await findJsonlFiles(sessionsRoot);
      if (files.length === 0) {
        return {
          status: 'unavailable',
          reason: 'No .jsonl session files found in Codex sessions directory',
        };
      }

      // Optionally check logs_2.sqlite for additional data
      try {
        const db = openExternalReadonly(logsDbPath);
        try {
          // Try to find a table with token info
          const tables = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table'",
            )
            .all() as Array<{ name: string }>;

          const hasTokenTable = tables.some((t) => {
            try {
              const columns = db
                .prepare(`PRAGMA table_info('${t.name}')`)
                .all() as Array<{ name: string }>;
              return columns.some(
                (c) =>
                  c.name.includes('token') ||
                  c.name.includes('input') ||
                  c.name.includes('output'),
              );
            } catch {
              return false;
            }
          });

          if (!hasTokenTable) {
            db.close();
            return {
              status: 'degraded',
              reason:
                'logs_2.sqlite exists but no stable token field found; using JSONL only',
            };
          }
          db.close();
        } catch {
          db.close();
          return {
            status: 'degraded',
            reason:
              'logs_2.sqlite exists but could not be queried for token fields',
          };
        }
      } catch (e) {
        // logs_2.sqlite not found — that's fine, JSONL is the primary source
        if (!(e instanceof ExternalDatabaseUnavailableError)) {
          return {
            status: 'degraded',
            reason: `Unexpected error checking logs_2.sqlite: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      return { status: 'ok' };
    },

    async tick(ctx: UsageCollectorContext): Promise<void> {
      const files = await findJsonlFiles(sessionsRoot);

      for (const filePath of files) {
        // Normalize the path for consistent DB keys
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
          // File disappeared or became unreadable between glob and read
          continue;
        }

        // If we've already read past the end of this file, skip
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
          currentOffset += lineByteLength + 1; // +1 for the \n

          // Skip empty lines
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            continue;
          }

          // Parse the JSON line
          const record = parseJsonLine(trimmed);
          if (record === null) {
            // Corrupt line — skip without aborting
            continue;
          }

          // Check for token fields
          if (!hasTokenFields(record)) {
            // No token data in this line — skip
            continue;
          }

          // Extract fields (NEVER store prompt/response/cookies/auth)
          const inputTokens = extractNumericField(record, INPUT_TOKEN_FIELDS);
          const outputTokens = extractNumericField(record, OUTPUT_TOKEN_FIELDS);
          const cacheTokens = extractNumericField(record, CACHE_TOKEN_FIELDS);
          const timestamp = extractTimestamp(record, ctx.now());
          const model = extractModel(record);
          const eventId = extractEventId(record);

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
