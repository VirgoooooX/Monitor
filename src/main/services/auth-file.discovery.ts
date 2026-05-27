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
import {
  enrichParseResultWithEmail,
  type FetchEmailForAccessToken,
} from './auth-file.email-enrichment';

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
  /**
   * Optional override for the Google userinfo lookup used to
   * recover an email from `gemini-cli` / `antigravity` access
   * tokens that ship without an `id_token`. Defaults to the live
   * implementation; tests inject a stub.
   *
   * Setting this to `null` disables the lookup entirely (useful in
   * environments where outbound HTTP must not happen).
   */
  fetchEmailForAccessToken?: FetchEmailForAccessToken | null;
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
    // Kiro IDE (AWS) — the desktop app stores its OAuth bundle here
    // regardless of platform. Schema:
    //   { accessToken, refreshToken, profileArn, expiresAt,
    //     authMethod, provider }
    // The profile ARN encodes the Q Developer region we need to
    // call `getUsageLimits` against.
    {
      provider: 'kiro-ide',
      filePath: path.join(home, '.aws', 'sso', 'cache', 'kiro-auth-token.json'),
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
  // Kiro IDE specific: the auth file ships with neither an account
  // id nor an email, and the access token rotates on every IDE
  // refresh — leaving the token-only fingerprint useless. The
  // CodeWhisperer profile ARN is the single stable identifier for a
  // Kiro account on a given machine, so promote it to a first-class
  // dedup dimension. Without this, every IDE-side token rotation
  // produces a brand-new "auto-discovered" row on the next Monitor
  // launch.
  if (
    provider === 'kiro-ide' &&
    typeof payload.kiroProfileArn === 'string' &&
    payload.kiroProfileArn.length > 0
  ) {
    out.push(`${provider}::kiroProfileArn::${payload.kiroProfileArn}`);
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

  // Pre-compaction: merge any pre-existing duplicate Kiro IDE rows
  // before we build the dedup index. Users who installed Monitor
  // before the `kiroProfileArn` fingerprint shipped accumulated one
  // new row per IDE-side token rotation; this collapses them into
  // a single row keyed by ARN so the rest of the pass treats them
  // as one logical account.
  const compactedReport = compactDuplicateKiroRows(
    deps.providerAuthRepo,
    deps.secrets,
  );

  const fingerprints = buildExistingFingerprintIndex(
    deps.providerAuthRepo,
    deps.secrets,
  );
  const refreshedIdsThisScan = new Set<string>();

  let imported = 0;
  let skipped = compactedReport.skipped;
  let failed = compactedReport.failed;
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
        // Best-effort enrichment for Google OAuth files that ship
        // without an `id_token` and without an inline `email`.
        // Failure is silent — the import still succeeds with the
        // parser-derived label.
        if (deps.fetchEmailForAccessToken !== null) {
          await enrichParseResultWithEmail(
            probe.provider,
            parsed,
            deps.fetchEmailForAccessToken,
          );
        }
        // Kiro IDE specific: stash the source file path on the
        // payload so the adapter knows where to write rotated
        // tokens back. Other providers don't need this — their
        // adapters never touch the source file.
        if (probe.provider === 'kiro-ide') {
          parsed.payload.kiroSourceFilePath = probe.filePath;
        }
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
  // Label upgrade: legacy rows imported before the parser learned
  // to decode `id_token` JWTs surfaced an `accountId`-shaped or
  // `<provider>:imported (自动发现)`-shaped label. When a fresh scan
  // can now derive an email for the same account, swap the row's
  // label to that email so the UI stops showing opaque numeric ids.
  // We never overwrite a label the user (or a future explicit
  // `metadata.label`) chose deliberately — only the auto-derived
  // shapes below are considered upgradeable.
  const nextLabel = chooseRefreshLabel(row.label, parsed, row.provider);
  const shouldPatch =
    secretChanged ||
    nextAccountId !== row.accountId ||
    nextProjectId !== row.projectId ||
    nextLabel !== row.label ||
    row.lastErrorCode !== null ||
    row.lastErrorMessage !== null;

  let nextRow = row;
  if (shouldPatch) {
    const timestamp = now();
    const patch: ProviderAuthUpdatePatch = {
      accountId: nextAccountId,
      projectId: nextProjectId,
      label: nextLabel,
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

/**
 * Decide whether a previously-discovered row's label should be
 * upgraded to the email derived from a fresh scan. Returns the new
 * label when an upgrade is warranted, or the original label otherwise.
 *
 * Upgrade triggers (any of):
 *   - The current label is exactly the row's `accountId` (or
 *     `accountId (自动发现)`) — i.e. an opaque numeric / auth0 id.
 *   - The current label starts with `<provider>:imported` —
 *     the parser's last-resort fallback.
 *   - The current label is the row's `projectId` (Google Cloud
 *     project ids like `vivid-course-453615-u9` aren't useful
 *     account labels for humans).
 *
 * In every other case we keep the existing label so a user-set or
 * CPA-`metadata.label` value never gets clobbered.
 */
function chooseRefreshLabel(
  currentLabel: string,
  parsed: ParseResult,
  provider: ProviderId,
): string {
  if (parsed.email === null || parsed.email.trim().length === 0) {
    return currentLabel;
  }
  const trimmed = currentLabel.trim();
  const stripSuffix = (s: string): string =>
    s.endsWith(' (自动发现)') ? s.slice(0, -' (自动发现)'.length).trim() : s;
  const core = stripSuffix(trimmed);
  const looksLikeAccountId =
    parsed.accountId !== null && core === parsed.accountId;
  const looksLikeProjectId =
    parsed.projectId !== null && core === parsed.projectId;
  const looksLikeFallback = core.startsWith(`${provider}:imported`);
  if (!looksLikeAccountId && !looksLikeProjectId && !looksLikeFallback) {
    return currentLabel;
  }
  return `${parsed.email} (自动发现)`;
}

// ---------------------------------------------------------------------------
// Pre-existing duplicate Kiro IDE rows
// ---------------------------------------------------------------------------

interface CompactReport {
  /** Rows merged into a kept survivor (deleted from the repo). */
  readonly skipped: number;
  /** Rows that could not be deleted because of a repository error. */
  readonly failed: number;
}

/**
 * Collapse Kiro IDE `provider_auth` rows that share the same
 * CodeWhisperer profile ARN into a single row, keeping the one
 * with the most recent `updatedAt` timestamp. Older Monitor
 * versions did not include `kiroProfileArn` in the dedup
 * fingerprint, which let every IDE-side access-token rotation
 * leak a brand-new "auto-discovered" row each time the user
 * relaunched Monitor. Running this pass at the start of every
 * `runDiscovery` cleans up the accumulated duplicates without
 * forcing the user to delete them by hand.
 *
 * Compaction rules:
 *   - Only `kiro-ide` rows are considered. Other providers ship
 *     stable identifiers (Google email, Codex / Claude account id)
 *     and never accumulate this kind of duplicate.
 *   - The "winner" of a duplicate group is the row with the
 *     largest `updatedAt`. Ties break on `lastValidatedAt`, then
 *     on `importedAt`. This naturally prefers the row whose
 *     `provider_auth` lifecycle is most active (i.e. the one the
 *     user most recently saw refresh successfully).
 *   - Loser rows have their secrets removed and their repo row
 *     deleted. Failures are counted but never abort the scan.
 *   - Rows whose secret payload cannot be decrypted are left
 *     untouched — better to preserve a stale row than to silently
 *     destroy an account whose ARN we can't read.
 */
function compactDuplicateKiroRows(
  repo: ProviderAuthRepository,
  secrets: SecretsAdmin,
): CompactReport {
  // Bucket rows by `kiroProfileArn`.
  type Bucket = ReadonlyArray<ProviderAuthRow>;
  const buckets = new Map<string, ProviderAuthRow[]>();

  for (const row of repo.list()) {
    if (row.provider !== 'kiro-ide') continue;
    let arn: string | null = null;
    try {
      const ciphertext = secrets.get(row.secretKey);
      if (ciphertext === null) continue;
      const payload = JSON.parse(ciphertext) as ProviderAuthSecretPayload;
      arn =
        typeof payload.kiroProfileArn === 'string' &&
        payload.kiroProfileArn.length > 0
          ? payload.kiroProfileArn
          : null;
    } catch {
      // Ciphertext unreadable — skip silently. Returning here
      // keeps the row in place; the user can clean it up via the
      // settings UI if needed.
      continue;
    }
    if (arn === null) continue;
    const list = buckets.get(arn);
    if (list === undefined) buckets.set(arn, [row]);
    else list.push(row);
  }

  let skipped = 0;
  let failed = 0;
  for (const [, group] of buckets) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(compareKiroRows);
    const survivor = sorted[0]!;
    const losers = sorted.slice(1);
    for (const loser of losers) {
      try {
        // Best-effort: remove the secret first so a half-deleted
        // row never leaves orphaned ciphertext lying around.
        try {
          secrets.remove(loser.secretKey);
        } catch {
          // ignore — row delete is the load-bearing step
        }
        repo.remove(loser.id);
        skipped += 1;
      } catch {
        failed += 1;
      }
    }
    void survivor; // explicit no-op; the survivor is implicitly kept.
  }

  return { skipped, failed };
}

/**
 * Sort comparator used by {@link compactDuplicateKiroRows}. Returns a
 * negative number when `a` is "more recent" than `b` so the survivor
 * lands at index 0 after `sort`. Ordering signals (descending
 * priority):
 *   1. error-free row beats an erroring row (even an older error-free
 *      row — Requirement: never elect an `auth_expired` survivor when
 *      a healthy peer exists).
 *   2. larger `updatedAt`
 *   3. larger `lastValidatedAt`
 *   4. larger `importedAt`
 */
function compareKiroRows(a: ProviderAuthRow, b: ProviderAuthRow): number {
  const aErr = a.lastErrorCode !== null ? 1 : 0;
  const bErr = b.lastErrorCode !== null ? 1 : 0;
  if (aErr !== bErr) return aErr - bErr;
  const byUpdated = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  if (byUpdated !== 0) return byUpdated;
  const byValidated = (b.lastValidatedAt ?? 0) - (a.lastValidatedAt ?? 0);
  if (byValidated !== 0) return byValidated;
  return (b.importedAt ?? 0) - (a.importedAt ?? 0);
}
