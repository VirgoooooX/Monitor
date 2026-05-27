// Claude Code project-session JSONL usage collector.
//
// References:
//   - design.md §AI Usage Collectors — Common Contract
//   - PLAN.md §AI Usage Collectors
//
// Scans `~/.claude/projects/<workspace>/<sessionId>.jsonl` for
// per-message token usage. Each Claude Code workspace lives in its
// own folder; every session is one append-only JSONL file. Assistant
// messages carry a `message.usage` block with the per-turn delta
// already split into input / cache-read / cache-creation / output.
//
// Wire shape (one line, abbreviated):
//   { "type": "assistant",
//     "message": {
//       "model": "deepseek-v4-pro",
//       "usage": {
//         "input_tokens": 46928,
//         "cache_creation_input_tokens": 0,
//         "cache_read_input_tokens": 0,
//         "output_tokens": 141,
//         ...
//       }
//     },
//     "timestamp": "2026-05-08T15:53:34.149Z",
//     "uuid": "f18a23c9-2b62-4b46-9fff-8cd579a1ee70",
//     ... }
//
// Privacy:
//   - NEVER stores prompt, response, message content, cookies, or
//     authorization headers. Only timestamp / model / token counts /
//     uuid are read.
//
// Dedup:
//   - UNIQUE(provider, source_path, source_offset) on `usage_events`
//     (set up by `db.ts`) makes re-scanning idempotent. Watermarks
//     are per-file so newly-appended turns are picked up on the next
//     tick without rewalking the whole history.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CapabilityResult } from '../../types';
import type { UsageCollector, UsageCollectorContext } from './Collector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CLAUDE_CODE_COLLECTOR_ID = 'usage.claude-code';
const PROVIDER = 'claude-code';
const SOURCE = 'claude-code.jsonl';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the Claude Code projects root directory. */
function getClaudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Walk every workspace folder under `projects/` and yield each
 * `*.jsonl` session file. The workspace folder structure is one
 * level deep, so a single `readdir` followed by per-workspace
 * `readdir` is enough — no recursion required.
 */
async function findSessionFiles(projectsRoot: string): Promise<string[]> {
  const results: string[] = [];
  let workspaces: fs.Dirent[];
  try {
    workspaces = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(projectsRoot, ws.name);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(wsPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(path.join(wsPath, entry.name));
      }
    }
  }
  return results;
}

/** Safely parse a JSON line. Returns null on any parse error. */
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

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  model: string | null;
  timestamp: number;
  eventId: string | null;
}

/**
 * Pull token usage out of one Claude Code JSONL line. Returns null
 * for non-assistant lines, lines without `message.usage`, and lines
 * where every counter is zero (typically session-bookkeeping turns
 * the upstream emits but doesn't bill).
 *
 * `cache_read_input_tokens` + `cache_creation_input_tokens` both
 * count as "cache" for our dashboard's three-bucket split.
 */
function extractClaudeUsage(
  record: Record<string, unknown>,
  fallbackTimestamp: number,
): ExtractedUsage | null {
  if (record['type'] !== 'assistant') return null;
  const message = asObject(record['message']);
  if (message === null) return null;
  const usage = asObject(message['usage']);
  if (usage === null) return null;

  const inputTokens = asNumber(usage['input_tokens']);
  const outputTokens = asNumber(usage['output_tokens']);
  const cacheRead = asNumber(usage['cache_read_input_tokens']);
  const cacheCreate = asNumber(usage['cache_creation_input_tokens']);
  const cacheTokens = cacheRead + cacheCreate;
  if (inputTokens === 0 && outputTokens === 0 && cacheTokens === 0) {
    return null;
  }

  // Model lives on `message.model`. Prefer it over any top-level
  // `model` field because Claude Code embeds the routed model
  // (e.g. `claude-sonnet-4-5`, `deepseek-v4-pro`) inside the
  // message envelope.
  const model =
    typeof message['model'] === 'string' && (message['model'] as string).length > 0
      ? (message['model'] as string)
      : null;

  // `timestamp` is on the top-level record, ISO-8601 in UTC.
  let timestamp = fallbackTimestamp;
  const tsField = record['timestamp'];
  if (typeof tsField === 'string') {
    const parsed = Date.parse(tsField);
    if (Number.isFinite(parsed) && parsed > 0) timestamp = parsed;
  } else if (typeof tsField === 'number' && Number.isFinite(tsField) && tsField > 0) {
    timestamp = tsField < 1e12 ? tsField * 1000 : tsField;
  }

  // The top-level `uuid` field is a stable per-message identifier.
  // Fall back to `message.id` (turn id) when missing.
  let eventId: string | null = null;
  if (typeof record['uuid'] === 'string' && (record['uuid'] as string).length > 0) {
    eventId = record['uuid'] as string;
  } else if (typeof message['id'] === 'string' && (message['id'] as string).length > 0) {
    eventId = message['id'] as string;
  }

  return { inputTokens, outputTokens, cacheTokens, model, timestamp, eventId };
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface ClaudeCodeCollectorDeps {
  /** Override the projects root for testing. Defaults to `~/.claude/projects`. */
  projectsRoot?: string;
}

export function createClaudeCodeCollector(
  deps?: ClaudeCodeCollectorDeps,
): UsageCollector {
  const projectsRoot = deps?.projectsRoot ?? getClaudeProjectsRoot();

  return {
    id: CLAUDE_CODE_COLLECTOR_ID,
    provider: PROVIDER,

    async capabilityCheck(): Promise<CapabilityResult> {
      try {
        await fs.promises.access(projectsRoot, fs.constants.R_OK);
      } catch {
        return {
          status: 'unavailable',
          reason: `Claude Code projects directory not found: ${projectsRoot}`,
        };
      }
      const files = await findSessionFiles(projectsRoot);
      if (files.length === 0) {
        return {
          status: 'unavailable',
          reason: 'No .jsonl session files found under ~/.claude/projects',
        };
      }
      return { status: 'ok' };
    },

    async tick(ctx: UsageCollectorContext): Promise<void> {
      const files = await findSessionFiles(projectsRoot);

      for (const filePath of files) {
        const normalizedPath = path.normalize(filePath);

        // Watermark-based incremental read. `MAX(source_offset)` for
        // this `(provider, source_path)` pair is the byte offset of
        // the LAST line we already inserted; we resume one byte
        // past it.
        const watermark =
          ctx.usageEvents.watermark(PROVIDER, normalizedPath) ?? -1;
        const startOffset = watermark + 1;

        let content: Buffer;
        try {
          content = await fs.promises.readFile(filePath);
        } catch {
          // Disappeared between scan and read — try again next tick.
          continue;
        }
        if (startOffset >= content.length) continue;

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

          const usage = extractClaudeUsage(record, ctx.now());
          if (usage === null) continue;

          ctx.usageEvents.insertIgnore({
            timestamp: usage.timestamp,
            provider: PROVIDER,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheTokens: usage.cacheTokens,
            costUsd: null,
            source: SOURCE,
            sourcePath: normalizedPath,
            sourceOffset: lineStartOffset,
            eventId: usage.eventId,
          });
        }
      }
    },
  };
}
