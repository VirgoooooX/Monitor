// Kiro IDE local token-usage collector.
//
// References:
//   - design.md §AI Usage Collectors — Common Contract
//   - PLAN.md §AI Usage Collectors
//
// Reads the Kiro agent's `tokens_generated.jsonl` log:
//
//   %APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\dev_data\tokens_generated.jsonl
//   ~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/dev_data/tokens_generated.jsonl  (macOS)
//   ~/.config/Kiro/User/globalStorage/kiro.kiroagent/dev_data/tokens_generated.jsonl  (Linux)
//
// Each line is one turn:
//   {"model":"agent","provider":"kiro","promptTokens":7483,"generatedTokens":0}
//
// `provider: "kiro"` here is Kiro's own routing tag — we still emit
// rows under the local provider id `kiro-ide` so they line up with
// the `provider_auth` row imported by auto-discovery.
//
// Privacy:
//   - The Kiro log only records numeric counts and a model name.
//   - We never read or surface prompt/response content (the file
//     does not contain any).
//
// Dedup:
//   - Kiro's log lacks a per-turn id, so we use the byte offset of
//     each line as the dedup key. Combined with the file path this
//     gives us the same idempotent re-scan property the other
//     local collectors rely on.
//
// Known limitations (verified 2026-05-28 against Kiro IDE 0.12.x on
// Windows; logged here so future investigators don't redo the work):
//
//   1. `promptTokens` is the *full context* sent into each model
//      call, not the new tokens added that turn. Kiro emits a row
//      every model invocation (including tool-call follow-ups), so
//      the same conversation history is re-counted on every line:
//
//          12011 → 12102 → 12117 → 12130 → 12141 → 12194 → 12230
//                  └── each row includes the previous turn's prompt ──┘
//
//      Summing the column therefore over-reports compared with what
//      Kiro actually bills. We still emit one row per line so the
//      bar chart reflects activity density correctly; just don't
//      treat the sum as "tokens consumed."
//
//   2. `generatedTokens` is always 0 in the local log. Kiro does
//      not record output tokens client-side. Output-token totals
//      for `kiro-ide` will always be 0 — that's the source, not a
//      bug here.
//
//   3. The `model` field is always the string `"agent"`. Kiro's
//      real model name (e.g. `claude-opus-4.7`) lives in
//      `workspace-sessions/<encoded-cwd>/<sessionId>.json` under
//      the `selectedModel` key, but the JSONL has no per-row
//      session id, so we cannot reliably correlate. We pass the
//      raw value through unchanged.
//
//   4. Authoritative usage (Kiro's own credit/invocation balance,
//      shown in the IDE's settings popup) does not live in this
//      JSONL at all. The `kiro-ide` quota adapter at
//      `services/quota/adapters/kiro-ide.adapter.ts` calls the
//      Kiro account API directly to retrieve `usageBreakdownList`.
//      An equivalent cached snapshot is also stored in
//      `globalStorage/state.vscdb` under the ItemTable key
//      `kiro.kiroAgent` →
//      `kiro.resourceNotifications.usageState.usageBreakdowns[]`,
//      but we do not read it here — the API response is fresher.
//      This collector stays focused on token counts.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CapabilityResult } from '../../types';
import type { UsageCollector, UsageCollectorContext } from './Collector';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KIRO_COLLECTOR_ID = 'usage.kiro-ide';
const PROVIDER = 'kiro-ide';
const SOURCE = 'kiro.tokens-generated.jsonl';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the per-platform Kiro `dev_data` log path. Returns the
 * single canonical location for the host OS — Kiro itself does not
 * use multiple roots so we don't probe alternates.
 */
function getDefaultKiroLogPath(): string {
  const home = os.homedir();
  const tail = path.join(
    'Kiro',
    'User',
    'globalStorage',
    'kiro.kiroagent',
    'dev_data',
    'tokens_generated.jsonl',
  );
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, tail);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', tail);
  }
  // Linux + everything else: follow XDG_CONFIG_HOME, fall back to ~/.config
  const xdg = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
  return path.join(xdg, tail);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function asNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface KiroCollectorDeps {
  /** Override the log path for testing. */
  logPath?: string;
}

export function createKiroCollector(deps?: KiroCollectorDeps): UsageCollector {
  const logPath = deps?.logPath ?? getDefaultKiroLogPath();

  return {
    id: KIRO_COLLECTOR_ID,
    provider: PROVIDER,

    async capabilityCheck(): Promise<CapabilityResult> {
      try {
        const stat = await fs.promises.stat(logPath);
        if (!stat.isFile()) {
          return {
            status: 'unavailable',
            reason: `Kiro tokens_generated.jsonl is not a regular file: ${logPath}`,
          };
        }
      } catch {
        return {
          status: 'unavailable',
          reason: `Kiro tokens_generated.jsonl not found: ${logPath}`,
        };
      }
      return { status: 'ok' };
    },

    async tick(ctx: UsageCollectorContext): Promise<void> {
      const normalizedPath = path.normalize(logPath);

      const watermark =
        ctx.usageEvents.watermark(PROVIDER, normalizedPath) ?? -1;
      const startOffset = watermark + 1;

      let content: Buffer;
      try {
        content = await fs.promises.readFile(logPath);
      } catch {
        return;
      }
      if (startOffset >= content.length) return;

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

        const inputTokens = asNumber(record['promptTokens']);
        const outputTokens = asNumber(record['generatedTokens']);
        if (inputTokens === 0 && outputTokens === 0) continue;

        // Kiro's log doesn't carry a per-turn timestamp, so we
        // stamp the row with `ctx.now()`. The row still survives
        // re-scans because the (sourcePath, sourceOffset) dedup
        // key is independent of timestamp; the watermark guarantees
        // we never re-read the same offset twice.
        const timestamp = ctx.now();

        const model =
          typeof record['model'] === 'string' && (record['model'] as string).length > 0
            ? (record['model'] as string)
            : null;

        ctx.usageEvents.insertIgnore({
          timestamp,
          provider: PROVIDER,
          model,
          inputTokens,
          outputTokens,
          cacheTokens: 0,
          costUsd: null,
          source: SOURCE,
          sourcePath: normalizedPath,
          sourceOffset: lineStartOffset,
          eventId: null,
        });
      }
    },
  };
}
