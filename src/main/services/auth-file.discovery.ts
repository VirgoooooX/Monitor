// Local AI auth-file auto-discovery.
//
// Scans the user's well-known per-provider credential paths
// (`~/.codex/auth.json`, `~/.claude/.credentials.json`,
// `~/.gemini/oauth_creds.json`, …), parses the matching JSON via
// the same {@link parseAuthFile} function the manual import flow
// uses, and registers any newly-found credential as a fresh
// `provider_auth` row with `enabled: true`.
//
// Why this lives in its own module:
//
//   - The discovery step is fire-and-forget at boot. It is allowed to
//     fail silently (a user without Codex installed should not see a
//     boot error); putting it next to `provider_auth.service` would
//     blur the strict "secrets-only" focus of that module.
//   - The path list is platform-conditioned. On Windows the Codex
//     auth file may live under `%USERPROFILE%\.codex\auth.json`; on
//     macOS Claude Code stores its credential blob inside the
//     keychain rather than a JSON file. We keep the list small and
//     practical: only the locations Codex / Claude Code / Gemini CLI
//     / Antigravity actually write today on any platform we support.
//   - Idempotency: each scan compares the parsed `accessToken` /
//     `apiKey` against the secrets already attached to live
//     `provider_auth` rows. Re-running the scan after a previous
//     import is a no-op — the user never gets duplicate accounts.
//
// Security model:
//
//   - The discovery service decrypts NO secrets it did not just
//     read. It is allowed to call `secrets.get` against rows it
//     created (or rows it is checking against) because the
//     auto-import path is main-only and the renderer never sees
//     the raw token.
//   - Read failures (missing file, EACCES, malformed JSON) are
//     swallowed individually. A bad Codex auth file MUST NOT
//     prevent Claude Code from being discovered.
//   - The label always carries an `(自动发现)` suffix so the user
//     can tell auto-imported accounts apart from manual imports
//     in the settings list.

import * as path from 'node:path';
import * as os from 'node:os';

import type { ProviderAuthRepository } from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';
import type { ProviderAuthSecretPayload, ProviderId } from '../types';
import { PROVIDER_DEFAULT_CAPABILITY } from '../types';
import { parseAuthFile, ProviderAuthError } from './auth-file.parser';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * One auto-discovery probe entry. Each entry pairs a `ProviderId`
 * with the absolute path to the credential file we expect that
 * provider to drop on disk. The first existing path per provider
 * wins; later entries for the same provider are silently skipped
 * once a row has been registered.
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
 * Build the default probe list from the user's home directory + the
 * platform-specific application-data root. Kept inside a function so
 * the list is computed lazily — `os.homedir()` is cheap but the
 * default is regenerated on every boot, and tests inject a static
 * list anyway.
 *
 * Path coverage:
 *   - Codex CLI               : `~/.codex/auth.json`
 *   - Claude Code              : `~/.claude/.credentials.json`
 *   - Gemini CLI / Antigravity : `~/.gemini/oauth_creds.json`
 *
 * Only the providers that store a JSON credential blob outside the
 * OS keychain are listed; manually-typed API keys (DeepSeek /
 * Xiaomi / OpenAI-compatible) have no canonical local file and
 * stay on the manual-entry path.
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
      filePath: path.join(home, '.antigravity', 'auth.json'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Internals
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

/**
 * Build the set of `(provider, accessToken|apiKey)` fingerprints
 * already represented by live `provider_auth` rows.
 *
 * The fingerprint is intentionally narrow: a user who imports the
 * same Codex auth file twice via different paths (manual import vs
 * auto-discovery) MUST end up with one row. Two accounts that
 * happen to share an `accountId` but have distinct tokens stay
 * distinct.
 *
 * Decryption failures are non-fatal — if a row's secret cannot be
 * read for any reason we treat it as "not in the fingerprint set"
 * so the auto-import path produces the new row regardless. The
 * worst case is a duplicate account, which is recoverable through
 * the delete button; the alternative (silently skipping the import)
 * would be much harder to debug.
 */
function buildExistingFingerprints(
  repo: ProviderAuthRepository,
  secrets: SecretsAdmin,
): Set<string> {
  const set = new Set<string>();
  for (const row of repo.list()) {
    let payload: ProviderAuthSecretPayload | null = null;
    try {
      const ciphertext = secrets.get(row.secretKey);
      if (ciphertext === null) continue;
      payload = JSON.parse(ciphertext) as ProviderAuthSecretPayload;
    } catch {
      continue;
    }
    if (typeof payload.accessToken === 'string' && payload.accessToken.length > 0) {
      set.add(`${row.provider}::token::${payload.accessToken}`);
    }
    if (typeof payload.apiKey === 'string' && payload.apiKey.length > 0) {
      set.add(`${row.provider}::key::${payload.apiKey}`);
    }
  }
  return set;
}

/** Compute the fingerprint for a parsed payload, or `null` if unknown. */
function payloadFingerprint(
  provider: ProviderId,
  payload: ProviderAuthSecretPayload,
): string | null {
  if (typeof payload.accessToken === 'string' && payload.accessToken.length > 0) {
    return `${provider}::token::${payload.accessToken}`;
  }
  if (typeof payload.apiKey === 'string' && payload.apiKey.length > 0) {
    return `${provider}::key::${payload.apiKey}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public: runDiscovery
// ---------------------------------------------------------------------------

/**
 * Scan every probe and import any unknown credential as a fresh
 * `provider_auth` row.
 *
 * The function is `async` so individual file I/O happens in
 * parallel; the report aggregates per-provider outcomes so callers
 * can log a one-line summary at boot ("auto-discovery: imported
 * 2, skipped 1, missing 5").
 *
 * Errors from any single probe are logged-and-swallowed; this
 * function never throws.
 */
export async function runDiscovery(
  deps: AuthFileDiscoveryDeps,
): Promise<DiscoveryReport> {
  const probes = deps.probes ?? defaultDiscoveryProbes();
  const readFile = deps.readFile ?? defaultReadFile;
  const fileExists = deps.fileExists ?? defaultFileExists;

  const fingerprints = buildExistingFingerprints(
    deps.providerAuthRepo,
    deps.secrets,
  );

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let missing = 0;

  // Collect outcomes via Promise.allSettled so a slow / hanging
  // disk read on one probe does not stall the others.
  const outcomes = await Promise.allSettled(
    probes.map(async (probe) => {
      if (!(await fileExists(probe.filePath))) {
        return { kind: 'missing' as const };
      }
      let raw: string;
      try {
        raw = await readFile(probe.filePath);
      } catch {
        return { kind: 'failed' as const };
      }
      let parsed;
      try {
        parsed = parseAuthFile(probe.provider, raw);
      } catch {
        return { kind: 'failed' as const };
      }
      const fp = payloadFingerprint(probe.provider, parsed.payload);
      if (fp !== null && fingerprints.has(fp)) {
        return { kind: 'skipped' as const };
      }
      // Avoid creating two rows from two probes that resolve to
      // the same fingerprint within a single scan (e.g. a user
      // with two probe paths whose contents are byte-identical).
      if (fp !== null) fingerprints.add(fp);
      return { kind: 'import' as const, probe, parsed };
    }),
  );

  // Apply the imports serially so SQLite doesn't see two concurrent
  // transactions writing rows + secrets — `provider_auth.service`
  // owns the txn boundary, and serial execution keeps the wiring
  // boringly correct.
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      failed += 1;
      continue;
    }
    const value = outcome.value;
    if (value.kind === 'missing') {
      missing += 1;
      continue;
    }
    if (value.kind === 'failed') {
      failed += 1;
      continue;
    }
    if (value.kind === 'skipped') {
      skipped += 1;
      continue;
    }
    try {
      registerDiscoveredAccount(deps, value.probe, value.parsed);
      imported += 1;
    } catch {
      failed += 1;
    }
  }

  return { imported, skipped, failed, missing };
}

// ---------------------------------------------------------------------------
// Lower-level: register one account
// ---------------------------------------------------------------------------

/**
 * Insert a fresh `provider_auth` row + matching secret for an
 * auto-discovered credential.
 *
 * We bypass `ProviderAuthService.importFromFile` because that
 * helper is wired to the OS file dialog; the auto-discovery path
 * already has the parsed payload in hand and writes through the
 * repository directly using the same atomic-secret-then-row
 * pattern. The label always carries the `(自动发现)` suffix so the
 * user can tell auto-imports apart at a glance.
 */
function registerDiscoveredAccount(
  deps: AuthFileDiscoveryDeps,
  probe: DiscoveryProbe,
  parsed: ReturnType<typeof parseAuthFile>,
): void {
  const uuid = deps.uuid ?? (() => globalThis.crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());

  const id = uuid();
  const secretKey = `cpaAuth.providerAuth.${id}`;
  const importedAt = now();

  const row = {
    id,
    provider: probe.provider,
    label: `${parsed.label} (自动发现)`,
    source: 'cpa-auth-file' as const,
    accountId: parsed.accountId,
    projectId: parsed.projectId,
    quotaCapability: PROVIDER_DEFAULT_CAPABILITY[probe.provider],
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
}
