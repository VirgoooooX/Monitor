// Provider Auth service — owns the import / list / delete / validate
// pipeline for CPA auth files. This is the only main-side module that
// pairs `secrets.set` with `provider_auth.insert` (and the reverse on
// delete) inside a single SQLite transaction.
//
// References:
//   - cpa-quota-import/design.md §Provider_Auth_Service
//   - cpa-quota-import/design.md §Import flow (happy path)
//   - cpa-quota-import/design.md §Storage Layout (two-step transactional
//       insert/delete)
//   - cpa-quota-import/design.md §validateLightweight
//   - cpa-quota-import/design.md §Error Handling
//   - cpa-quota-import/requirements.md Requirement 1.3, 1.4, 1.5,
//       7.6, 7.7, 8.1–8.5, 9.1, 9.2, 9.5, 11.4, 15.4
//
// =============================================================================
// SECURITY MODEL — READ BEFORE TOUCHING THIS FILE
// =============================================================================
//
// The `Provider_Auth_Service` is the only main-side module allowed to
// produce a `ProviderAuthMetadata` value for the renderer. Every code
// path here funnels through the {@link redactRow} projection so a
// `secretKey` field can never escape into an IPC envelope — the
// projection is type-driven (`ProviderAuthMetadata` literally lacks
// the column), not a runtime filter (Requirement 1.1, 1.4).
//
// `importFromFile` is the only entry point that reads a file from
// disk; the renderer cannot push a path or content (Requirement 1.3,
// 8.1, 8.2). The dialog runs in main (`deps.showOpenDialog`) and the
// returned `filePaths[0]` is consumed once; it never crosses the IPC
// boundary, never lands in a log, never appears in an error message.
//
// All errors thrown across this module are `ProviderAuthError`
// instances. The IPC layer (task 10.3) maps them to the
// `IpcResult` envelope using the closed `ProviderAuthErrorCode`
// union. Messages are bounded to ≤80 chars and pre-redacted —
// callers MUST NOT thread a raw token / API key / file path into a
// `ProviderAuthError` message.
//
// =============================================================================

import type {
  ProviderAuthErrorCode,
  ProviderAuthMetadata,
  ProviderAuthSecretPayload,
  ProviderId,
  ProviderAuthDiagnosticsEntry,
  CreateProviderAuthApiKeyInput,
  SetProviderAuthEnabledInput,
  ManualApiKeyProvider,
} from '../types';
import { PROVIDER_DEFAULT_CAPABILITY } from '../types';
import type {
  ProviderAuthRepository,
  ProviderAuthRow,
} from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';
import {
  ProviderAuthError,
  type ParseResult,
  type parseAuthFile as parseAuthFileFn,
} from './auth-file.parser';

// Re-export `ProviderAuthError` so callers (the IPC mapper, tests)
// can `import { ProviderAuthError } from '../services/provider_auth.service'`
// without reaching into the parser module.
export { ProviderAuthError };

// ---------------------------------------------------------------------------
// Public surface — types
// ---------------------------------------------------------------------------

/**
 * Result of a `validate(id)` call. Mirrors `design.md §Provider_Auth_Service`.
 *
 *   - `ok: true`  → `code: 'ok'`, `message: ''`.
 *   - `ok: false` → `code` is one of the closed `ProviderAuthErrorCode`
 *                   union members, `message` is bounded to ≤80 chars
 *                   and pre-redacted.
 */
export interface ProviderAuthValidationResult {
  ok: boolean;
  code: ProviderAuthErrorCode | 'ok';
  /** ≤80 chars, redacted. */
  message: string;
}

/**
 * Public service interface, threaded into the IPC layer by `app.ts`.
 *
 * The renderer only ever sees `ProviderAuthMetadata` (the redacted
 * projection of {@link ProviderAuthRow}); `importFromFile` returns the
 * row that was just inserted, after the lightweight validation step.
 */
export interface ProviderAuthService {
  /** All accounts, ordered by `imported_at ASC`. No secret decryption. */
  list(): ProviderAuthMetadata[];
  /**
   * Run the full import pipeline: dialog → parse → secret + row write
   * inside a single SQLite transaction → lightweight validate.
   *
   * @throws {ProviderAuthError} on any failure; the error code is
   *   one of `cancelled | unsupported_file | parse_error | auth_missing`
   *   plus `SecretsUnavailableError` / `SecretsDecryptError` from the
   *   underlying secrets module (left to propagate so the IPC layer can
   *   map them to `unavailable` / `auth_expired`).
   */
  importFromFile(input: { provider: ProviderId }): Promise<ProviderAuthMetadata>;
  /**
   * Create a new account from a manually-typed API key. Only the
   * `ManualApiKeyProvider` subset is accepted (OAuth-style providers
   * must use `importFromFile`). The returned metadata is structurally
   * redacted — the API key is never echoed back.
   *
   * @throws {ProviderAuthError} with code `validation` for empty
   *   `apiKey`, missing `baseUrl` on `'openai-compatible'`, or any
   *   other shape violation; `SecretsUnavailableError` /
   *   `SecretsDecryptError` propagate from the secret store.
   */
  createApiKey(input: CreateProviderAuthApiKeyInput): ProviderAuthMetadata;
  /**
   * Toggle the per-account `enabled` flag. Returns the updated
   * metadata, or `null` when the id does not exist (idempotent —
   * matches the {@link remove} contract). Disabling does not delete
   * the row or the secret; it just opts the account out of every
   * scheduled refresh path.
   */
  setEnabled(input: SetProviderAuthEnabledInput): ProviderAuthMetadata | null;
  /** Idempotent delete; safe to call when no row exists. */
  remove(id: string): void;
  /** Lightweight (no upstream call) validate of a stored account. */
  validate(id: string): ProviderAuthValidationResult;
}

/**
 * Dependency contract. All capabilities are injected so the factory
 * stays pure and tests can supply in-memory doubles.
 *
 * Notes:
 *   - `secrets` is a {@link SecretsAdmin} (not a raw `SecretsModule`)
 *     because Provider_Auth secret keys are NOT on the renderer-facing
 *     allowlist; the admin wrapper enforces the
 *     `cpaAuth.providerAuth.<uuid>` regex that the renderer-facing
 *     `updateSecret` callback cannot reach.
 *   - `transaction` is optional. When provided (typically
 *     `db.transaction`) the secret-write + row-write pair runs inside
 *     a single SQLite transaction so the ACID guarantee covers both.
 *     When omitted (test doubles, early-boot ordering), the service
 *     falls back to a try/catch with explicit secret rollback — the
 *     fallback gives the same observable "no orphan row" property at
 *     the cost of a non-atomic crash window (acceptable for tests).
 */
export interface ProviderAuthServiceDeps {
  repo: ProviderAuthRepository;
  secrets: SecretsAdmin;
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  readFile: (p: string) => Promise<string>;
  statFile: (p: string) => Promise<{ size: number }>;
  parse: typeof parseAuthFileFn;
  uuid: () => string;
  now: () => number;
  /** Optional SQLite transaction wrapper. See note above. */
  transaction?: <T>(fn: () => T) => T;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for diagnostics reuse — task 13.1)
// ---------------------------------------------------------------------------

/**
 * Project a `ProviderAuthRow` (row shape, includes `secretKey`) onto the
 * renderer-visible {@link ProviderAuthMetadata} shape. The `secretKey`
 * column is dropped — by construction, not by runtime filter — so a
 * `redactRow(row)` value is safe to embed in any IPC envelope or
 * diagnostics export.
 *
 * Exported so the diagnostics service (`design.md §Diagnostics`,
 * task 13.1) can reuse the same projection without re-deriving the
 * column whitelist.
 */
export function redactRow(row: ProviderAuthRow): ProviderAuthMetadata {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    source: row.source,
    accountId: row.accountId,
    projectId: row.projectId,
    quotaCapability: row.quotaCapability,
    importedAt: row.importedAt,
    updatedAt: row.updatedAt,
    lastValidatedAt: row.lastValidatedAt,
    lastQuotaAt: row.lastQuotaAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    enabled: row.enabled,
  };
}

/**
 * Diagnostics-only projection of a `provider_auth` row (task 13.1,
 * Requirement 13.4). Excludes `label`, `accountId`, and `projectId`
 * by Q5 resolution — these fields are semi-sensitive (a label can
 * carry a personal email; the project id and account id can identify
 * the user) and are not needed for support-bundle triage. The
 * surfaced columns are exactly the closed-set troubleshooting
 * fields: `id`, `provider`, `quotaCapability`, `lastErrorCode`,
 * `lastQuotaAt`, `lastValidatedAt`.
 *
 * Co-located with `redactRow` so the IPC and diagnostics whitelists
 * live next to the row shape they project from.
 */
export function diagnosticsRow(row: ProviderAuthRow): ProviderAuthDiagnosticsEntry {
  return {
    id: row.id,
    provider: row.provider,
    quotaCapability: row.quotaCapability,
    lastErrorCode: row.lastErrorCode,
    lastQuotaAt: row.lastQuotaAt,
    lastValidatedAt: row.lastValidatedAt,
  };
}

/**
 * Maximum length of any pre-redacted error message persisted to
 * `provider_auth.last_error_message` or returned across IPC. Pinned
 * by Requirement 1.4 and `schemas.ts` (`z.string().max(80)`).
 */
const MAX_ERROR_MESSAGE_LEN = 80;

/**
 * Bound a redacted error message to ≤80 chars. The truncation is
 * idempotent and never changes a message that is already short
 * enough; longer values are sliced (no "…" suffix — the trailing
 * char is part of the budget so we keep the message deterministic
 * for snapshot tests).
 */
function bound(message: string): string {
  return message.length <= MAX_ERROR_MESSAGE_LEN
    ? message
    : message.slice(0, MAX_ERROR_MESSAGE_LEN);
}

/**
 * Allowed file extensions. Per Requirement 7.6 and 8.2 we accept
 * `.json` and `.txt` (the dialog also accepts `All Files` as a
 * fallback, which is why we re-validate here regardless of what the
 * dialog filter let through).
 */
const ACCEPTABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.json', '.txt']);

function getExtension(filePath: string): string {
  // Pure, dependency-free extname: find the last `.` after the final
  // path separator. Importing `node:path` would force a runtime
  // dependency on `path` for what is essentially a tail-string scan.
  const lastSlash = Math.max(
    filePath.lastIndexOf('/'),
    filePath.lastIndexOf('\\'),
  );
  const tail = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const dot = tail.lastIndexOf('.');
  if (dot <= 0) return ''; // leading-dot files have no extension
  return tail.slice(dot).toLowerCase();
}

function isAcceptableExtension(filePath: string): boolean {
  const ext = getExtension(filePath);
  // An empty extension is also acceptable per Requirement 7.6
  // ("无扩展名" is allowed alongside `.json` / `.txt`).
  if (ext === '') return true;
  return ACCEPTABLE_EXTENSIONS.has(ext);
}

/** 1 MiB in bytes — matches Requirement 7.7 / design.md §Import flow. */
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Lightweight validation rules (design.md §validateLightweight)
// ---------------------------------------------------------------------------

/**
 * Per-provider pre-flight check on the parsed Secret_Payload. Does
 * NOT call upstream — only inspects which fields the parser was able
 * to extract. The result feeds both the `importFromFile` finaliser
 * (writing `lastErrorCode` / `lastErrorMessage` to the new row) and
 * the standalone `validate(id)` IPC handler.
 *
 * Rules:
 *   - `claude-code`            : `accessToken` non-empty.
 *   - `codex`                  : `accessToken` non-empty (account_id is
 *                                informational).
 *   - `gemini-cli` / `antigravity` : `accessToken` AND `projectId`;
 *                                missing project surfaces as
 *                                `project_missing` (Requirement 11.4).
 *   - `gemini-api` / `deepseek` / `openai-compatible`  : `apiKey` non-empty.
 *   - `xiaomi`                 : `xiaomiPassToken` AND `xiaomiUserId`
 *                                non-empty (the cookie pair feeds
 *                                the on-demand serviceToken refresh
 *                                in `xiaomi.adapter.ts`).
 */
function validateLightweight(
  provider: ProviderId,
  payload: ProviderAuthSecretPayload,
): ProviderAuthValidationResult {
  const hasAccessToken =
    typeof payload.accessToken === 'string' && payload.accessToken.length > 0;
  const hasApiKey =
    typeof payload.apiKey === 'string' && payload.apiKey.length > 0;
  const hasProjectId =
    typeof payload.projectId === 'string' && payload.projectId.length > 0;

  switch (provider) {
    case 'claude-code':
    case 'codex':
      if (!hasAccessToken) {
        return {
          ok: false,
          code: 'auth_missing',
          message: bound('access token missing from imported payload'),
        };
      }
      return { ok: true, code: 'ok', message: '' };

    case 'gemini-cli':
    case 'antigravity':
      if (!hasAccessToken) {
        return {
          ok: false,
          code: 'auth_missing',
          message: bound('access token missing from imported payload'),
        };
      }
      if (!hasProjectId) {
        return {
          ok: false,
          code: 'project_missing',
          message: bound('project id missing for OAuth provider'),
        };
      }
      return { ok: true, code: 'ok', message: '' };

    case 'gemini-api':
    case 'deepseek':
    case 'openai-compatible':
      if (!hasApiKey) {
        return {
          ok: false,
          code: 'auth_missing',
          message: bound('api key missing from imported payload'),
        };
      }
      return { ok: true, code: 'ok', message: '' };

    case 'xiaomi': {
      const hasPassToken =
        typeof payload.xiaomiPassToken === 'string' &&
        payload.xiaomiPassToken.length > 0;
      const hasXiaomiUserId =
        typeof payload.xiaomiUserId === 'string' &&
        payload.xiaomiUserId.length > 0;
      // Backwards compatibility: pre-cookie xiaomi rows that were
      // imported as API keys still validate as ok at this stage so
      // the row stays usable; the adapter surfaces the upgrade
      // requirement via `auth_missing` on the next refresh.
      if (!hasPassToken && !hasXiaomiUserId && !hasApiKey) {
        return {
          ok: false,
          code: 'auth_missing',
          message: bound('xiaomi credentials missing from imported payload'),
        };
      }
      if ((hasPassToken && !hasXiaomiUserId) || (!hasPassToken && hasXiaomiUserId)) {
        return {
          ok: false,
          code: 'auth_missing',
          message: bound('xiaomi passToken and userId must both be present'),
        };
      }
      return { ok: true, code: 'ok', message: '' };
    }

    default: {
      // Exhaustiveness guard — `ProviderId` is a closed union, so the
      // unreachable branch is a TypeScript error if a new value is
      // added without updating the switch above.
      const exhaustive: never = provider;
      void exhaustive;
      return {
        ok: false,
        code: 'validation',
        message: bound('unknown provider'),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link ProviderAuthService} bound to its dependencies.
 *
 * The factory is synchronous and performs no I/O — it only captures
 * `deps`. Side-effects only happen on `importFromFile` /
 * `remove` / `validate` invocations.
 */
export function createProviderAuthService(
  deps: ProviderAuthServiceDeps,
): ProviderAuthService {
  const {
    repo,
    secrets,
    showOpenDialog,
    readFile,
    statFile,
    parse,
    uuid,
    now,
    transaction,
  } = deps;

  /**
   * Run `fn` inside a SQLite transaction when the optional
   * `transaction` dep is wired; otherwise execute `fn` directly. The
   * caller-visible behaviour of `importFromFile` / `remove` matches
   * either way — atomicity is upgraded when the wrapper exists.
   */
  function runInTxn<T>(fn: () => T): T {
    return transaction ? transaction(fn) : fn();
  }

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------
  function list(): ProviderAuthMetadata[] {
    return repo.list().map(redactRow);
  }

  // -------------------------------------------------------------------------
  // importFromFile()
  // -------------------------------------------------------------------------
  async function importFromFile({
    provider,
  }: {
    provider: ProviderId;
  }): Promise<ProviderAuthMetadata> {
    // 1. Open the OS file dialog. The renderer may not bypass this
    //    step — the dialog runs in main, the returned path is
    //    consumed once and never crosses IPC.
    const dlg = await showOpenDialog();
    if (dlg.canceled || dlg.filePaths.length === 0) {
      throw new ProviderAuthError(
        'cancelled',
        bound('user cancelled file selection'),
      );
    }

    const filePath = dlg.filePaths[0]!;

    // 2. Re-validate the extension (the dialog filter is advisory —
    //    Requirement 8.2 requires us to re-check after readFile, and
    //    the cheapest defence is to fail before we even read).
    if (!isAcceptableExtension(filePath)) {
      throw new ProviderAuthError(
        'unsupported_file',
        bound('only .json or .txt files are accepted'),
      );
    }

    // 3. Stat-check size — refuse anything over 1 MiB. The path is
    //    NOT included in the error message (Requirement 7.8).
    const stat = await statFile(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new ProviderAuthError(
        'parse_error',
        bound('file too large (>1 MiB)'),
      );
    }

    // 4. Read the file as utf-8.
    const raw = await readFile(filePath);

    // 5. Parse via the injected parser. The parser itself throws
    //    `ProviderAuthError('parse_error', ...)` on any structural
    //    failure with a sanitised message; we let it propagate.
    const parsed: ParseResult = parse(provider, raw);

    // 6. Build the row and the secret key. UUID is supplied by the
    //    deps so tests can inject a deterministic generator; in
    //    production this is `crypto.randomUUID`.
    const id = uuid();
    const secretKey = `cpaAuth.providerAuth.${id}`;
    const importedAt = now();

    const row: ProviderAuthRow = {
      id,
      provider,
      label: parsed.label,
      source: 'cpa-auth-file',
      accountId: parsed.accountId,
      projectId: parsed.projectId,
      quotaCapability: PROVIDER_DEFAULT_CAPABILITY[provider],
      importedAt,
      updatedAt: importedAt,
      lastValidatedAt: null,
      lastQuotaAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      enabled: true,
      secretKey,
    };

    // 7. Atomic write: secret first (so a `repo.insert` failure can
    //    explicitly roll the secret back), then the row. Wrapped in
    //    a transaction when the dep is wired.
    runInTxn(() => {
      secrets.set(secretKey, JSON.stringify(parsed.payload));
      try {
        repo.insert(row);
      } catch (err) {
        // Rollback the orphan secret. `secrets.remove` is idempotent
        // so a double-call is safe; we still re-throw so the caller
        // sees the underlying SQLite error.
        try {
          secrets.remove(secretKey);
        } catch {
          // Swallow — the original error is what matters; the
          // rollback failure is a secondary concern that we'd only
          // surface in a structured log if we had one. The next
          // boot will see an orphan secret with no matching row,
          // which is harmless (the provider_auth list is the index
          // of truth).
        }
        throw err;
      }
    });

    // 8. Lightweight validate (Requirement 11.4). This must NOT call
    //    upstream — it only inspects which fields the parser
    //    extracted. The validation result is persisted onto the new
    //    row so the renderer sees the correct `lastErrorCode` /
    //    `lastErrorMessage` on its first `list()` call.
    const validation = validateLightweight(provider, parsed.payload);
    const validatedAt = now();
    repo.update(id, {
      updatedAt: validatedAt,
      lastValidatedAt: validatedAt,
      lastErrorCode: validation.ok
        ? null
        : (validation.code as ProviderAuthErrorCode),
      lastErrorMessage: validation.ok ? null : bound(validation.message),
    });

    // 9. Build the redacted projection from the new state. We
    //    deliberately reconstruct the metadata locally (rather than
    //    re-fetching via `repo.get(id)`) so the call stays O(1) and
    //    test doubles do not need to re-implement `get`.
    const finalised: ProviderAuthRow = {
      ...row,
      updatedAt: validatedAt,
      lastValidatedAt: validatedAt,
      lastErrorCode: validation.ok
        ? null
        : (validation.code as ProviderAuthErrorCode),
      lastErrorMessage: validation.ok ? null : bound(validation.message),
    };
    return redactRow(finalised);
  }

  // -------------------------------------------------------------------------
  // remove()
  // -------------------------------------------------------------------------
  function remove(id: string): void {
    // Idempotent: we do NOT short-circuit on a missing row. `repo.remove`
    // and `secrets.remove` are both idempotent at their respective
    // layers (DELETE affecting zero rows is not an error; the secrets
    // store treats a missing key as a no-op). Pairing them inside a
    // single transaction keeps the "no orphan secret" invariant under
    // a concurrent reader.
    const secretKey = `cpaAuth.providerAuth.${id}`;
    runInTxn(() => {
      repo.remove(id);
      secrets.remove(secretKey);
    });
  }

  // -------------------------------------------------------------------------
  // createApiKey()
  // -------------------------------------------------------------------------
  //
  // Manual API-key entry path. Symmetric to `importFromFile` (atomic
  // secret + row write inside `runInTxn`, lightweight validate to
  // populate `lastErrorCode`) but skips the file dialog and the
  // CPA parser — we already know the API key and the optional
  // base URL the user typed in.
  //
  // Validation rules duplicated from the IPC schema layer so the
  // service is robust on its own (the schema is the first line of
  // defence; the duplication keeps unit tests honest):
  //
  //   - Non-Xiaomi providers : `apiKey` non-empty after `trim()`.
  //   - `provider === 'openai-compatible'` requires `baseUrl`.
  //   - `provider === 'xiaomi'` requires `xiaomiPassToken` AND
  //     `xiaomiUserId` (cookie-pair); `apiKey` is rejected because
  //     the platform balance API does not honour it.
  //   - For any provider, `baseUrl` (when present) is forwarded
  //     verbatim — additional URL parsing is the schema's job.
  //
  // The new row defaults to `enabled: true` so the next refresh
  // tick picks it up immediately.
  function createApiKey(
    input: CreateProviderAuthApiKeyInput,
  ): ProviderAuthMetadata {
    const baseUrl =
      typeof input.baseUrl === 'string' && input.baseUrl.trim().length > 0
        ? input.baseUrl.trim()
        : undefined;

    let payload: ProviderAuthSecretPayload;

    if (input.provider === 'xiaomi') {
      const passToken =
        typeof input.xiaomiPassToken === 'string'
          ? input.xiaomiPassToken.trim()
          : '';
      const xiaomiUserId =
        typeof input.xiaomiUserId === 'string'
          ? input.xiaomiUserId.trim()
          : '';
      if (passToken.length === 0 || xiaomiUserId.length === 0) {
        throw new ProviderAuthError(
          'validation',
          bound('xiaomi requires both passToken and userId'),
        );
      }
      payload = {
        xiaomiPassToken: passToken,
        xiaomiUserId,
      };
    } else {
      const apiKey =
        typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
      if (apiKey.length === 0) {
        throw new ProviderAuthError(
          'validation',
          bound('api key must not be empty'),
        );
      }
      if (input.provider === 'openai-compatible' && baseUrl === undefined) {
        throw new ProviderAuthError(
          'validation',
          bound('base url is required for openai-compatible'),
        );
      }
      payload = baseUrl !== undefined ? { apiKey, baseUrl } : { apiKey };
    }

    const id = uuid();
    const secretKey = `cpaAuth.providerAuth.${id}`;
    const importedAt = now();

    const label =
      typeof input.label === 'string' && input.label.trim().length > 0
        ? input.label.trim()
        : defaultLabelFor(input.provider);

    const row: ProviderAuthRow = {
      id,
      provider: input.provider,
      label,
      source: 'manual-api-key',
      accountId: null,
      projectId: null,
      quotaCapability: PROVIDER_DEFAULT_CAPABILITY[input.provider],
      importedAt,
      updatedAt: importedAt,
      lastValidatedAt: null,
      lastQuotaAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      enabled: true,
      secretKey,
    };

    runInTxn(() => {
      secrets.set(secretKey, JSON.stringify(payload));
      try {
        repo.insert(row);
      } catch (err) {
        try {
          secrets.remove(secretKey);
        } catch {
          // See importFromFile() — the original error is what matters.
        }
        throw err;
      }
    });

    // Lightweight validate. For an API-key payload the only thing
    // we can check is "apiKey is non-empty", which we already
    // enforced above; the call is still useful because it persists
    // `lastValidatedAt` so the UI shows a fresh "刚刚校验" timestamp.
    const validation = validateLightweight(input.provider, payload);
    const validatedAt = now();
    repo.update(id, {
      updatedAt: validatedAt,
      lastValidatedAt: validatedAt,
      lastErrorCode: validation.ok
        ? null
        : (validation.code as ProviderAuthErrorCode),
      lastErrorMessage: validation.ok ? null : bound(validation.message),
    });

    const finalised: ProviderAuthRow = {
      ...row,
      updatedAt: validatedAt,
      lastValidatedAt: validatedAt,
      lastErrorCode: validation.ok
        ? null
        : (validation.code as ProviderAuthErrorCode),
      lastErrorMessage: validation.ok ? null : bound(validation.message),
    };
    return redactRow(finalised);
  }

  // -------------------------------------------------------------------------
  // setEnabled()
  // -------------------------------------------------------------------------
  //
  // Toggle the per-account refresh opt-in. Idempotent on a missing
  // id (returns `null`, mirroring `remove`'s no-op-on-missing
  // contract — the IPC handler maps that into a successful envelope).
  //
  // Quota cache eviction for `enabled=false` is the QuotaService's
  // responsibility (`refresh({ id })` deletes the cache entry when
  // it sees `enabled=false`); we keep this method narrowly focused
  // on the row write so it stays trivial to test.
  function setEnabled(
    input: SetProviderAuthEnabledInput,
  ): ProviderAuthMetadata | null {
    const existing = repo.get(input.id);
    if (existing === null) {
      return null;
    }
    // Short-circuit when the value is already correct — avoids a
    // pointless `updatedAt` bump on a no-op toggle.
    if (existing.enabled === input.enabled) {
      return redactRow(existing);
    }
    const ts = now();
    repo.update(input.id, {
      enabled: input.enabled,
      updatedAt: ts,
    });
    const updated: ProviderAuthRow = {
      ...existing,
      enabled: input.enabled,
      updatedAt: ts,
    };
    return redactRow(updated);
  }

  /**
   * Default label used when the user does not supply one in the
   * manual API-key form. Falls back to the provider's zh-CN brand
   * label so the row is recognisable in the settings list at a
   * glance.
   */
  function defaultLabelFor(provider: ManualApiKeyProvider): string {
    switch (provider) {
      case 'gemini-api':
        return 'Gemini API key';
      case 'deepseek':
        return 'DeepSeek API key';
      case 'xiaomi':
        return '小米 Mimo';
      case 'openai-compatible':
        return 'OpenAI 兼容 API key';
    }
  }

  // -------------------------------------------------------------------------
  // validate()
  // -------------------------------------------------------------------------
  function validate(id: string): ProviderAuthValidationResult {
    const row = repo.get(id);
    if (row === null) {
      return {
        ok: false,
        code: 'validation',
        message: bound('account not found'),
      };
    }

    // Decrypt the secret payload. `secrets.get` may throw
    // `SecretsUnavailableError` / `SecretsDecryptError`; we catch
    // here and translate to the closed `ProviderAuthErrorCode` set so
    // the IPC layer can pass the result through without further
    // re-mapping. The original error message is NOT propagated —
    // both error classes already produce sanitised messages, but the
    // 80-char bound trims them defensively.
    let payload: ProviderAuthSecretPayload;
    try {
      const ciphertext = secrets.get(row.secretKey);
      if (ciphertext === null) {
        // Row exists but secret is gone — surface as `auth_missing`
        // so the UI prompts the user to re-import.
        const result: ProviderAuthValidationResult = {
          ok: false,
          code: 'auth_missing',
          message: bound('secret payload missing for account'),
        };
        persistValidation(row.id, result);
        return result;
      }
      payload = JSON.parse(ciphertext) as ProviderAuthSecretPayload;
    } catch (err) {
      // `SecretsDecryptError` / `SecretsUnavailableError` are the
      // expected failures here; JSON.parse throwing means the stored
      // ciphertext is corrupt, which we treat as `auth_expired`
      // (re-import recovers). We never thread the underlying
      // message through — it could in principle contain plaintext
      // fragments.
      const code: ProviderAuthErrorCode =
        err instanceof Error && err.name === 'SecretsUnavailableError'
          ? 'auth_missing'
          : 'auth_expired';
      const result: ProviderAuthValidationResult = {
        ok: false,
        code,
        message: bound(
          code === 'auth_missing'
            ? 'secret storage unavailable'
            : 'secret payload could not be decrypted',
        ),
      };
      persistValidation(row.id, result);
      return result;
    }

    const result = validateLightweight(row.provider, payload);
    persistValidation(row.id, result);
    return result;
  }

  /**
   * Persist the validation outcome onto the `provider_auth` row so the
   * next `list()` call reflects it. Always updates `lastValidatedAt`;
   * `lastErrorCode` / `lastErrorMessage` are cleared on success.
   */
  function persistValidation(
    id: string,
    result: ProviderAuthValidationResult,
  ): void {
    const validatedAt = now();
    repo.update(id, {
      updatedAt: validatedAt,
      lastValidatedAt: validatedAt,
      lastErrorCode: result.ok
        ? null
        : (result.code as ProviderAuthErrorCode),
      lastErrorMessage: result.ok ? null : bound(result.message),
    });
  }

  return {
    list,
    importFromFile,
    createApiKey,
    setEnabled,
    remove,
    validate,
  };
}
