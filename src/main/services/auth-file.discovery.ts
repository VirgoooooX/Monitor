// Local AI auth-file auto-discovery.
//
// Scans well-known per-CLI credential paths and registers any
// previously-unknown account as a fresh `provider_auth` row with
// `enabled: true`.
//
// Covered CLIs:
//   - Codex CLI       : `~/.codex/auth.json`
//   - Claude Code     : `~/.claude/.credentials.json`
//   - Gemini CLI      : `~/.gemini/oauth_creds.json`
//   - Antigravity     : `~/.antigravity/oauth_creds.json`
//                        + legacy `~/.gemini/antigravity/oauth_creds.json`
//
// OpenCode is intentionally NOT discovered: OpenCode (sst/opencode)
// has no native usage / quota API, and its `~/.config/opencode/auth.json`
// is a credential bundle for OTHER providers (anthropic, openai,
// google, deepseek). Any anthropic OAuth token in there is the same
// account a user already has in `~/.claude/.credentials.json`, so
// importing it would add a duplicate row pointing at the same upstream
// account without any quota visibility we don't already get from the
// Claude Code path.
//
// Idempotency / dedup:
//   - Every existing `provider_auth` row contributes a set of
//     fingerprints derived from its decrypted secret payload:
//     `(provider, accountId)`, `(provider, accessToken)`,
//     `(provider, apiKey)`, plus retained metadata email when present.
//   - Newly-discovered candidates are matched against the same set
//     before insert. The accountId / email fingerprints are the
//     stable ones; token fingerprints are a fallback for credentials
//     whose source file does not surface an account identity.

import * as path from 'node:path';
import * as os from 'node:os';

import type {
  ProviderAuthRepository,
  ProviderAuthRow,
  ProviderAuthUpdatePatch,
} from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';
import type { ProviderAuthSecretPayload, ProviderId } from '../types';
import { PROVIDER_DEFAULT_CAPABILITY } from '../types';
import {
  parseAuthFile,
  ProviderAuthError,
  type ParseResult,
} from './auth-file.parser';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * One auto-discovery probe entry. Each entry pairs a `ProviderId`
 * with the absolute path to the credential file we expect that
 * provider to drop on disk.
 */
export interface DiscoveryProbe {
  readonly provider: ProviderId;
  readonly filePath: string;
}

export interface DiscoveryReport {
  /** Number of new `provider_auth` rows inserted by this scan. */
  readonly imported: number;
  /** Number of probes that matched an existing row (no-op). */
  readonly skipped: number;
  /** Number of probes that found a file but failed to parse. */
  readonly failed: number;
  /** Number of probes whose file did not exist. */
  readonly missing: number;
}

export interface AuthFileDiscoveryDeps {
  providerAuthRepo: ProviderAuthRepository;
  secrets: SecretsAdmin;
  /** Inject a custom probe list for tests; defaults to {@link defaultDiscoveryProbes}. */
  probes?: ReadonlyArray<DiscoveryProbe>;
  readFile?: (p: string) => Promise<string>;
  fileExists?: (p: string) => Promise<boolean>;
  uuid?: () => string;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Default probe list
// ---------------------------------------------------------------------------

/**
 * Build the default probe list from the user's home directory. Kept
 * inside a function so tests can stub `os.homedir()` via the deps.
 *
 * Manual-only providers (DeepSeek, Xiaomi, OpenAI-compatible) have
 * no canonical local file; users add them through the API-key form.
 */
export function defaultDiscoveryProbes(): DiscoveryProbe[] {
  const home = os.homedir();
  return [
    { provider: 'codex', filePath: path.join(home, '.codex', 'auth.json') },
    {
      provider: 'claude-code',
      filePath: path.join(home, '.claude', '.credentials.json'),
    },
    {
      provider: 'gemini-cli',
      filePath: path.join(home, '.gemini', 'oauth_creds.json'),
    },
    {
      provider: 'antigravity',
      filePath: path.join(home, '.antigravity', 'oauth_creds.json'),
    },
    // Antigravity legacy / alternative location used by some
    // builds. Kept after the canonical path so the canonical one
    // wins the same-scan dedup when both exist.
    {
      provider: 'antigravity',
      filePath: path.join(home, '.gemini', 'antigravity', 'oauth_creds.json'),
    },
  ];
}

// ---------------------------------------------------------------------------
// I/O helpers (overridable in tests)
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MiB — same bound as importFromFile.

async function defaultReadFile(p: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(p);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new ProviderAuthError(
      'parse_error',
      'auto-discovery: file too large (>1 MiB)',
    );
  }
  return fs.readFile(p, 'utf-8');
}

async function defaultFileExists(p: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Fingerprint dimensions an existing `provider_auth` row contributes
 * to the dedup set. The accountId / email dimensions are stable
 * across token rotation; the token dimensions are a last-resort
 * fallback.
 */
function fingerprintsFor(payload: ProviderAuthSecretPayload, provider: ProviderId): string[] {
  const out: string[] = [];
  if (typeof payload.accountId === 'string' && payload.accountId.length > 0) {
    out.push(`${provider}::account::${payload.accountId}`);
  }
  if (typeof payload.accessToken === 'string' && payload.accessToken.length > 0) {
    out.push(`${provider}::token::${payload.accessToken}`);
  }
  if (typeof payload.apiKey === 'string' && payload.apiKey.length > 0) {
    out.push(`${provider}::key::${payload.apiKey}`);
  }
  const email = emailFromPayload(payload);
  if (email !== null) {
    out.push(`${provider}::email::${email.toLowerCase()}`);
  }
  return out;
}

function emailFromPayload(payload: ProviderAuthSecretPayload): string | null {
  for (const block of [payload.rawMetadata, payload.rawAttributes]) {
    if (block === undefined) continue;
    const email = block['email'];
    if (typeof email === 'string' && email.trim().length > 0) {
      return email.trim();
    }
  }
  return null;
}

function fingerprintsForCandidate(
  provider: ProviderId,
  parsed: ParseResult,
): string[] {
  const out = fingerprintsFor(parsed.payload, provider);
  // `parsed.email` is not on the secret payload (we don't store it
  // on the row) — feed it in directly so two files for the same
  // Google account dedupe even when only one of them carries an
  // accountId.
  if (parsed.email !== null && parsed.email.length > 0) {
    out.push(`${provider}::email::${parsed.email.toLowerCase()}`);
  }
  if (parsed.accountId !== null && parsed.accountId.length > 0) {
    out.push(`${provider}::account::${parsed.accountId}`);
  }
  return out;
}

interface FingerprintEntry {
  readonly row: ProviderAuthRow;
  readonly payloadJson: string | null;
}

function addFingerprint(
  index: Map<string, FingerprintEntry>,
  fingerprint: string,
  entry: FingerprintEntry,
): void {
  if (!index.has(fingerprint)) {
    index.set(fingerprint, entry);
  }
}

function buildExistingFingerprintIndex(
  repo: ProviderAuthRepository,
  secrets: SecretsAdmin,
): Map<string, FingerprintEntry> {
  const index = new Map<string, FingerprintEntry>();
  for (const row of repo.list()) {
    let payload: ProviderAuthSecretPayload | null = null;
    let payloadJson: string | null = null;
    try {
      payloadJson = secrets.get(row.secretKey);
      if (payloadJson !== null) {
        payload = JSON.parse(payloadJson) as ProviderAuthSecretPayload;
      }
    } catch {
      payload = null;
      payloadJson = null;
    }

    const entry: FingerprintEntry = { row, payloadJson };
    if (row.accountId !== null && row.accountId.length > 0) {
      addFingerprint(index, `${row.provider}::account::${row.accountId}`, entry);
    }
    if (payload !== null) {
      for (const fp of fingerprintsFor(payload, row.provider)) {
        addFingerprint(index, fp, entry);
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Public: runDiscovery
// ---------------------------------------------------------------------------

/**
 * Scan every probe and import any unknown credential as a fresh
 * `provider_auth` row.
 *
 * Errors from any single probe are aggregated into the report and
 * never escape the function.
 */
export async function runDiscovery(
  deps: AuthFileDiscoveryDeps,
): Promise<DiscoveryReport> {
  const probes = deps.probes ?? defaultDiscoveryProbes();
  const readFile = deps.readFile ?? defaultReadFile;
  const fileExists = deps.fileExists ?? defaultFileExists;

  const fingerprints = buildExistingFingerprintIndex(
    deps.providerAuthRepo,
    deps.secrets,
  );
  const refreshedIdsThisScan = new Set<string>();

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let missing = 0;

  // Phase 1: read + parse every probe in parallel.
  type Outcome =
    | { kind: 'missing' }
    | { kind: 'failed' }
    | { kind: 'parsed'; provider: ProviderId; parsed: ParseResult };

  const outcomes: Outcome[] = await Promise.all(
    probes.map<Promise<Outcome>>(async (probe) => {
      if (!(await fileExists(probe.filePath))) {
        return { kind: 'missing' };
      }
      let raw: string;
      try {
        raw = await readFile(probe.filePath);
      } catch {
        return { kind: 'failed' };
      }
      try {
        const parsed = parseAuthFile(probe.provider, raw);
        return { kind: 'parsed', provider: probe.provider, parsed };
      } catch {
        return { kind: 'failed' };
      }
    }),
  );

  // Phase 2: dedup + import serially so SQLite txns don't overlap.
  for (const outcome of outcomes) {
    if (outcome.kind === 'missing') {
      missing += 1;
      continue;
    }
    if (outcome.kind === 'failed') {
      failed += 1;
      continue;
    }
    const fps = fingerprintsForCandidate(outcome.provider, outcome.parsed);
    const collision = firstCollision(fingerprints, fps);
    if (collision !== null) {
      if (refreshedIdsThisScan.has(collision.row.id)) {
        skipped += 1;
        continue;
      }
      try {
        const refreshed = refreshExistingDiscoveredAccount(
          deps,
          collision,
          outcome.parsed,
        );
        for (const fp of fps) {
          fingerprints.set(fp, {
            row: refreshed.row,
            payloadJson: refreshed.payloadJson,
          });
        }
        refreshedIdsThisScan.add(collision.row.id);
        skipped += 1;
      } catch {
        failed += 1;
      }
      continue;
    }
    try {
      const row = registerDiscoveredAccount(deps, outcome.provider, outcome.parsed);
      const payloadJson = JSON.stringify(outcome.parsed.payload);
      for (const fp of fps) fingerprints.set(fp, { row, payloadJson });
      imported += 1;
    } catch {
      failed += 1;
    }
  }

  return { imported, skipped, failed, missing };
}

function firstCollision(
  fingerprints: Map<string, FingerprintEntry>,
  candidates: readonly string[],
): FingerprintEntry | null {
  for (const fp of candidates) {
    const entry = fingerprints.get(fp);
    if (entry !== undefined) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lower-level: register one account
// ---------------------------------------------------------------------------

function registerDiscoveredAccount(
  deps: AuthFileDiscoveryDeps,
  provider: ProviderId,
  parsed: ParseResult,
): ProviderAuthRow {
  const uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());

  const id = uuid();
  const secretKey = `cpaAuth.providerAuth.${id}`;
  const importedAt = now();

  const row = {
    id,
    provider,
    label: `${parsed.label} (自动发现)`,
    source: 'cpa-auth-file' as const,
    accountId: parsed.accountId,
    projectId: parsed.projectId,
    quotaCapability: PROVIDER_DEFAULT_CAPABILITY[provider],
    importedAt,
    updatedAt: importedAt,
    lastValidatedAt: importedAt,
    lastQuotaAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    enabled: true,
    secretKey,
  };

  // Atomic write: secret first so a row-insert failure can roll the
  // secret back. Mirrors the contract `provider_auth.service` uses
  // for the manual import path.
  deps.secrets.set(secretKey, JSON.stringify(parsed.payload));
  try {
    deps.providerAuthRepo.insert(row);
  } catch (err) {
    try {
      deps.secrets.remove(secretKey);
    } catch {
      // Same swallow rationale as `provider_auth.service`.
    }
    throw err;
  }
  return row;
}

function refreshExistingDiscoveredAccount(
  deps: AuthFileDiscoveryDeps,
  entry: FingerprintEntry,
  parsed: ParseResult,
): FingerprintEntry {
  const now = deps.now ?? (() => Date.now());
  const payloadJson = JSON.stringify(parsed.payload);
  const row = entry.row;
  const secretChanged = entry.payloadJson !== payloadJson;

  if (secretChanged) {
    deps.secrets.set(row.secretKey, payloadJson);
  }

  const nextAccountId = row.accountId ?? parsed.accountId;
  const nextProjectId = row.projectId ?? parsed.projectId;
  const shouldPatch =
    secretChanged ||
    nextAccountId !== row.accountId ||
    nextProjectId !== row.projectId ||
    row.lastErrorCode !== null ||
    row.lastErrorMessage !== null;

  let nextRow = row;
  if (shouldPatch) {
    const timestamp = now();
    const patch: ProviderAuthUpdatePatch = {
      accountId: nextAccountId,
      projectId: nextProjectId,
      updatedAt: timestamp,
      lastValidatedAt: timestamp,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    deps.providerAuthRepo.update(row.id, patch);
    nextRow = {
      ...row,
      ...patch,
    };
  }

  return { row: nextRow, payloadJson };
}
