// Atomic read-merge-write helper for `~/.aws/sso/cache/kiro-auth-token.json`.
//
// The Monitor and the Kiro desktop IDE share this file: both read the
// `accessToken` / `refreshToken` / `expiresAt` triple to drive their
// own request loops, and the IDE rewrites the file on every refresh
// it performs. We follow the same protocol so a Monitor-side refresh
// keeps the IDE working too, instead of silently breaking its
// next-launch login.
//
// Three invariants drive the design:
//
//   1. **Preserve unknown fields.** The IDE's schema may grow new
//      keys over time (`authMethod`, `provider`, `clientIdHash`, …
//      already exist). We MUST round-trip every key the file
//      contains, otherwise upgrades will silently strip data. The
//      writer reads → JSON-parses → merges only the four token
//      fields → writes the merged JSON back.
//
//   2. **Atomic replace.** A torn write would leave the IDE without
//      a refresh token and force an interactive login. We write
//      to a sibling `<file>.tmp`, fsync, then rename onto the real
//      path. POSIX rename is atomic; Windows `rename` over an
//      existing target is also atomic since Vista (the IDE itself
//      relies on this).
//
//   3. **Best-effort.** A failure to rewrite the IDE file MUST NOT
//      break the Monitor refresh — the new tokens are already on
//      the encrypted `secrets` row, and the next auto-discovery
//      pass will reconcile the file copy. The writer surfaces
//      errors as typed `ProviderAdapterError` codes so the adapter
//      can decide whether to log + continue or to bubble up.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ProviderAdapterError } from './common';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KiroAuthFileSnapshot {
  /** Latest access token from a successful refresh. */
  readonly accessToken: string;
  /** Latest refresh token (may be the same value if the server didn't rotate). */
  readonly refreshToken: string;
  /** Epoch ms — written as ISO-8601 to match the IDE's format. */
  readonly expiresAt: number;
  /** Profile ARN from the response, or `null` to leave the existing value untouched. */
  readonly profileArn: string | null;
}

export interface KiroAuthFileExisting {
  /** Parsed top-level object — every key is preserved on write. */
  readonly raw: Record<string, unknown>;
  /** Convenience extracts pulled from `raw` for race-detection logic. */
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read and parse `kiro-auth-token.json`. Returns `null` if the file
 * does not exist (the caller treats that as "skip"); throws
 * `ProviderAdapterError('parse_error')` if the file exists but is
 * malformed.
 *
 * The convenience extracts (`accessToken`, `refreshToken`,
 * `expiresAt`) are sourced ONLY from the canonical top-level keys
 * the IDE writes — we do not search nested paths here, that's the
 * job of `auth-file.parser.ts` during import. This keeps the
 * race-detection logic predictable: if the IDE writes a fresh token
 * with the same shape we expect, we see it; if a future schema
 * change moves the keys, the convenience fields fall back to `null`
 * and the adapter will simply refresh on its own.
 */
export async function readKiroAuthFile(
  filePath: string,
): Promise<KiroAuthFileExisting | null> {
  let buf: string;
  try {
    buf = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new ProviderAdapterError(
      'parse_error',
      'Kiro IDE auth file unreadable',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buf);
  } catch {
    throw new ProviderAdapterError(
      'parse_error',
      'Kiro IDE auth file is not valid JSON',
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderAdapterError(
      'parse_error',
      'Kiro IDE auth file is not a JSON object',
    );
  }

  const raw = parsed as Record<string, unknown>;
  return {
    raw,
    accessToken: stringField(raw['accessToken']),
    refreshToken: stringField(raw['refreshToken']),
    expiresAt: parseExpiresAtMs(raw['expiresAt']),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Atomically rewrite `kiro-auth-token.json` with the rotated token
 * fields, preserving every other key the file already contains.
 *
 * Failure modes:
 *   - Source file missing → throws `parse_error` (caller decides
 *     whether to swallow). Most callers should guard with
 *     `readKiroAuthFile` returning non-null first.
 *   - Source file malformed → throws `parse_error`. We refuse to
 *     overwrite an unreadable file because that could destroy
 *     unrelated user state (e.g. the IDE wrote a partial JSON we
 *     don't recognise).
 *   - Write / fsync / rename failures → throws `network_error`
 *     (filesystem rather than network, but the code reuses the
 *     "transient, retry next tick" semantics).
 */
export async function writeKiroAuthFile(
  filePath: string,
  snapshot: KiroAuthFileSnapshot,
): Promise<void> {
  const existing = await readKiroAuthFile(filePath);
  if (existing === null) {
    throw new ProviderAdapterError(
      'parse_error',
      'Kiro IDE auth file vanished before write',
    );
  }

  const next: Record<string, unknown> = { ...existing.raw };
  next['accessToken'] = snapshot.accessToken;
  next['refreshToken'] = snapshot.refreshToken;
  next['expiresAt'] = new Date(snapshot.expiresAt).toISOString();
  if (snapshot.profileArn !== null) {
    next['profileArn'] = snapshot.profileArn;
  }

  // Match the IDE's pretty-printed format (two-space indent, trailing
  // newline) so the diff users see between IDE writes and our writes
  // stays clean.
  const serialized = `${JSON.stringify(next, null, 2)}\n`;

  const tmpPath = `${filePath}.tmp`;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, 'w', 0o600);
    await handle.writeFile(serialized, { encoding: 'utf-8' });
    // fsync ensures the data is durable before the rename completes.
    // Without this, a power loss between rename and flush could leave
    // the renamed file empty.
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, filePath);
  } catch {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // already in error state; nothing more to do
      }
    }
    // Best-effort cleanup of the temp file. Failure is non-fatal —
    // the next refresh will overwrite it anyway.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore — tmp file may not exist
    }
    throw new ProviderAdapterError(
      'network_error',
      'Kiro IDE auth file write failed',
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The IDE writes `expiresAt` as ISO-8601 (`"2026-05-27T14:40:43.287Z"`).
 * We parse defensively: epoch ms numbers, ISO strings, and any other
 * shape `Date.parse` accepts all round-trip. Anything else returns
 * `null` so the caller treats the file as "no usable hint".
 */
function parseExpiresAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Build an absolute path that lives in the same directory as
 * `kiro-auth-token.json` so the temp file is on the same filesystem
 * (rename atomicity requires same-volume).
 *
 * Exposed only for tests; runtime callers go through
 * {@link writeKiroAuthFile}.
 */
export function tempPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `${base}.tmp`);
}
