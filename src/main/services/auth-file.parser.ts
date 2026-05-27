// CPA auth file parser — extracts a normalised `Provider_Auth` payload
// from the heterogeneous JSON shapes that CLIProxyAPI exports for
// Claude Code, Codex (ChatGPT), Gemini CLI, Antigravity, and the
// plain-API-key providers (Gemini API, DeepSeek, Xiaomi,
// OpenAI-compatible).
//
// References:
//   - cpa-quota-import/requirements.md Requirement 7 (field priority
//     lists, retained Secret Payload keys, sanitised error contract)
//   - cpa-quota-import/design.md §CPA auth file parser (priority
//     constants verbatim, label derivation, ParseResult shape)
//
// Design choices encoded here:
//
// - **Pure, string-in / structure-out**. The parser does no I/O. The
//   caller (`provider_auth.service`) is responsible for opening the
//   dialog, stat-checking the file (≤1 MiB), and reading bytes; the
//   parser only ever sees the resulting UTF-8 string. This keeps the
//   parser trivially testable and keeps the file path off the parser
//   error surface (Requirement 7.8).
// - **Priority lists are first-match-wins**. Each priority list (see
//   `ACCESS_TOKEN_PATHS` etc.) is walked in declared order; the first
//   non-empty string match terminates the search. This mirrors
//   Requirement 7.1–7.4 and matches the CPA-side precedence: provider
//   files often carry both a top-level alias and a nested
//   authoritative copy, and the nested copy is the source of truth.
// - **`metadata.token` polymorphism**. CPA writes `metadata.token`
//   either as a string (the bare access token) or as an object
//   (`{ access_token, refresh_token, expiry }`). The string-only
//   `findFirstString` helper naturally skips the object case; the
//   nested fields are still picked up by earlier paths
//   (`metadata.token.access_token` is priority 2).
// - **Defense-in-depth redaction in `rawMetadata` / `rawAttributes`**.
//   The Secret Payload retains the verbatim `metadata` / `attributes`
//   blocks (Requirement 7.5) so v1.1 adapters can read provider-
//   specific extras (scopes, plan labels, IDE-type hints) without
//   re-parsing the file. Before storage we deep-strip any key whose
//   name matches a known secret or chat-content label
//   (`access_token`, `refresh_token`, `token`, `id_token`, `cookie`,
//   `api_key`, `key`, `tokens`, plus `prompt` / `response` /
//   `messages` for chat-content closure required by Property 1).
//   Extracted values still live on first-class fields of
//   `ProviderAuthSecretPayload`; the strip just prevents duplicate
//   storage and accidental chat-content leakage from arbitrary CPA
//   exports.
// - **Sanitised error messages**. Every parse failure throws
//   `ProviderAuthError('parse_error', ...)` with a fixed,
//   ≤80-character message. The parser never embeds raw input,
//   token/key fragments, or filesystem paths in the error
//   (Requirement 7.8) — those concerns sit upstream.

import type {
  ProviderAuthErrorCode,
  ProviderAuthSecretPayload,
  ProviderId,
} from '../types';

/**
 * Closed-set domain error for the Provider_Auth pipeline. The parser
 * itself only ever throws with `code: 'parse_error'`; other codes
 * (`unsupported_file`, `cancelled`, …) are reserved for the service
 * layer.
 */
export class ProviderAuthError extends Error {
  override readonly name = 'ProviderAuthError';
  constructor(
    public readonly code: ProviderAuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Result of a successful parse. The `label` is a best-effort derived
 * value (see `LABEL_FALLBACK_ORDER`); the service layer is free to
 * enrich it with a UUID suffix for uniqueness.
 */
export interface ParseResult {
  label: string;
  accountId: string | null;
  projectId: string | null;
  /**
   * User-readable email address when the source file carries one
   * (CPA `metadata.email`, raw OAuth tokens with an `email` claim,
   * etc.). NOT persisted on the `provider_auth` row directly — the
   * auto-discovery layer uses it as a fingerprint to deduplicate
   * "the same Google account imported via two different files".
   */
  email: string | null;
  payload: ProviderAuthSecretPayload;
}

// ---------------------------------------------------------------------------
// Field-extraction priority lists (Requirement 7.1–7.4 verbatim, plus
// the auxiliary lists called for by design.md §CPA auth file parser).
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_PATHS: ReadonlyArray<readonly string[]> = [
  // CPA-exported wrapper format (the original v1 import path).
  ['metadata', 'access_token'],
  ['metadata', 'token', 'access_token'],
  ['access_token'],
  ['token', 'access_token'],
  ['metadata', 'token'], // when value is string, treat as token
  ['metadata', 'id_token'],
  ['metadata', 'cookie'],
  // Native CLI on-disk formats — picked up by the auto-discovery
  // path. Codex CLI writes `~/.codex/auth.json` with a `tokens`
  // sub-object; Claude Code writes `~/.claude/.credentials.json`
  // with a `claudeAiOauth` sub-object. Both ship in the official
  // CLIs and predate the CPA wrapper format, so the discovery flow
  // would fail to parse them without these extra paths.
  ['tokens', 'access_token'],
  ['claudeAiOauth', 'accessToken'],
  // Kiro IDE (`~/.aws/sso/cache/kiro-auth-token.json`) writes
  // top-level camelCase keys.
  ['accessToken'],
];

const API_KEY_PATHS: ReadonlyArray<readonly string[]> = [
  ['attributes', 'api_key'],
  ['api_key'],
  ['key'],
];

const ACCOUNT_ID_PATHS: ReadonlyArray<readonly string[]> = [
  ['metadata', 'account_id'],
  ['account_id'],
  ['ChatGPT-Account-Id'],
  ['tokens', 'account_id'],
];

const PROJECT_ID_PATHS: ReadonlyArray<readonly string[]> = [
  ['metadata', 'project_id'],
  ['project_id'],
  ['projectId'],
  ['installed', 'project_id'],
  ['web', 'project_id'],
];

const EXPIRY_PATHS: ReadonlyArray<readonly string[]> = [
  ['expiry'],
  ['expired'],
  ['timestamp'],
  ['expires_in'],
  ['metadata', 'expiry'],
  ['metadata', 'expires_in'],
  // Native CLI: Claude uses `claudeAiOauth.expiresAt` (epoch ms),
  // Gemini CLI / Antigravity use `expiry_date` (epoch ms).
  ['claudeAiOauth', 'expiresAt'],
  ['expiry_date'],
  // Kiro IDE — top-level ISO-8601 string ("2026-05-27T14:40:43.287Z");
  // `parseExpiryEpochMs` falls through to `Date.parse` for textual
  // values.
  ['expiresAt'],
];

// Auxiliary path lists. The service layer / lightweight validate path
// will treat a missing `refreshToken` as informational only; it is the
// `accessToken` (or `apiKey`) that gates a successful import.
const REFRESH_TOKEN_PATHS: ReadonlyArray<readonly string[]> = [
  // CPA wrapper.
  ['metadata', 'refresh_token'],
  ['metadata', 'token', 'refresh_token'],
  ['refresh_token'],
  ['token', 'refresh_token'],
  ['tokens', 'refresh_token'],
  // Claude Code native.
  ['claudeAiOauth', 'refreshToken'],
  // Kiro IDE — top-level camelCase.
  ['refreshToken'],
];

const BASE_URL_PATHS: ReadonlyArray<readonly string[]> = [
  ['base_url'],
  ['metadata', 'base_url'],
  ['attributes', 'base_url'],
];

const LABEL_PATHS: ReadonlyArray<readonly string[]> = [
  ['metadata', 'label'],
  ['attributes', 'label'],
];

const EMAIL_PATHS: ReadonlyArray<readonly string[]> = [
  ['metadata', 'email'],
  ['attributes', 'email'],
  ['email'],
  ['account', 'email'],
];

/**
 * Paths where OIDC `id_token` JWTs may live. Codex (`tokens.id_token`)
 * and Gemini CLI / Antigravity (`metadata.id_token`) both ship a
 * standards-compliant OIDC id_token whose payload carries an `email`
 * claim. We fall back to decoding that JWT when none of the
 * `EMAIL_PATHS` resolve.
 *
 * The decode is unauthenticated — we never verify the signature.
 * That's fine because:
 *   1. The file is on the user's local disk; we treat it as trusted
 *      input the same way we treat the access_token / refresh_token
 *      it ships next to.
 *   2. We only consume the `email` claim for display purposes, never
 *      for authorization decisions.
 *   3. Avoiding signature verification keeps us off the JOSE / JWKS
 *      dependency surface entirely.
 */
const ID_TOKEN_PATHS: ReadonlyArray<readonly string[]> = [
  ['tokens', 'id_token'],
  ['metadata', 'id_token'],
  ['id_token'],
];

/**
 * Key names whose values must NEVER survive into `rawMetadata` /
 * `rawAttributes`:
 *
 *   - `access_token`, `refresh_token`, `token`, `id_token`, `cookie`,
 *     `api_key`, `key`, `tokens` — already extracted to first-class
 *     fields; keeping a duplicate copy would break the secret
 *     round-trip invariant (`requirements.md` Property 10 extension).
 *   - `prompt`, `response`, `messages` — defensive closure for
 *     Property 1 (no chat-content fragments leak through arbitrary
 *     CPA exports).
 */
const REDACTED_KEY_NAMES: ReadonlySet<string> = new Set([
  'access_token',
  'refresh_token',
  'token',
  'id_token',
  'cookie',
  'api_key',
  'key',
  'tokens',
  'prompt',
  'response',
  'messages',
]);

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getByPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** First non-empty string match across the provided paths, else `null`. */
function findFirstString(
  root: unknown,
  paths: ReadonlyArray<readonly string[]>,
): string | null {
  for (const path of paths) {
    const value = getByPath(root, path);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Best-effort expiry coercion to epoch milliseconds.
 *
 *   - Numeric `expires_in` is treated as a duration in seconds and
 *     anchored to `Date.now()`.
 *   - Other numeric values are heuristically epoch ms vs epoch s
 *     (split at 1e12; values below are seconds).
 *   - String values are parsed as numbers first, then via
 *     `Date.parse` for ISO-8601-ish inputs.
 *
 * Returns `undefined` when no candidate is recognisable; the service
 * layer treats absence as "unknown expiry" rather than an error.
 */
function parseExpiryEpochMs(root: unknown): number | undefined {
  for (const path of EXPIRY_PATHS) {
    const value = getByPath(root, path);
    if (value === undefined || value === null) continue;
    const isDurationSeconds = path[path.length - 1] === 'expires_in';
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (isDurationSeconds) return Date.now() + Math.round(value * 1000);
      return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric > 0) {
        if (isDurationSeconds) return Date.now() + Math.round(numeric * 1000);
        return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
      }
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Deep-strip every key whose name appears in `REDACTED_KEY_NAMES`.
 * Arrays are walked element-wise; non-object leaves are passed
 * through. Returns `undefined` when the input is not a plain object
 * or when stripping leaves the top-level object empty.
 */
function stripBlock(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const stripped = deepStrip(value) as Record<string, unknown>;
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}

function deepStrip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepStrip);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (REDACTED_KEY_NAMES.has(key)) continue;
      out[key] = deepStrip(child);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// JWT helpers — UNAUTHENTICATED `id_token` decode for the email claim
// ---------------------------------------------------------------------------
//
// OIDC id_tokens (Google for Gemini CLI / Antigravity, OpenAI for
// Codex) carry an `email` claim in the JWT payload. We base64url-
// decode the middle segment to pull it out without verifying the
// signature; see `ID_TOKEN_PATHS` for the threat-model rationale.
//
// The helper is defensive: any malformed JWT returns `null`. We never
// throw — a bad id_token must not break the import for an otherwise
// valid auth file.

function base64urlDecodeToString(input: string): string | null {
  if (input.length === 0) return null;
  // Convert base64url → base64 + restore padding.
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad !== 0) return null;
  try {
    // Buffer is always available in the main process (Node).
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const decoded = base64urlDecodeToString(parts[1]!);
  if (decoded === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoded);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Pull a usable `email` out of any JWT found at one of `ID_TOKEN_PATHS`.
 * Returns `null` when no path resolves, the JWT is malformed, or the
 * payload's `email` claim is missing / non-string / empty after trim.
 */
function findEmailFromIdTokens(root: unknown): string | null {
  for (const path of ID_TOKEN_PATHS) {
    const value = getByPath(root, path);
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const claims = decodeJwtPayload(value.trim());
    if (claims === null) continue;
    const email = claims['email'];
    if (typeof email === 'string' && email.trim().length > 0) {
      return email.trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a raw CPA auth-file string into a normalised `ParseResult`.
 *
 * The caller has already validated extension + size (≤1 MiB); this
 * function only enforces structural invariants:
 *
 *   1. The input is valid JSON.
 *   2. The top-level value is a JSON object.
 *   3. At least one of `accessToken` / `apiKey` is present.
 *
 * Any failure throws `ProviderAuthError('parse_error', ...)` with a
 * sanitised, ≤80-character message; the original input never leaks
 * into the message (Requirement 7.8).
 */
export function parseAuthFile(provider: ProviderId, raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderAuthError('parse_error', 'invalid JSON');
  }

  if (!isPlainObject(parsed)) {
    throw new ProviderAuthError('parse_error', 'expected a JSON object at the top level');
  }

  const accessToken = findFirstString(parsed, ACCESS_TOKEN_PATHS);
  const apiKey = findFirstString(parsed, API_KEY_PATHS);
  if (!accessToken && !apiKey) {
    throw new ProviderAuthError('parse_error', 'no recognised auth fields');
  }

  const refreshToken = findFirstString(parsed, REFRESH_TOKEN_PATHS);
  const accountId = findFirstString(parsed, ACCOUNT_ID_PATHS);
  const projectId = findFirstString(parsed, PROJECT_ID_PATHS);
  const baseUrl = findFirstString(parsed, BASE_URL_PATHS);
  const expiresAt = parseExpiryEpochMs(parsed);

  const rawMetadata = stripBlock((parsed as Record<string, unknown>).metadata);
  const rawAttributes = stripBlock((parsed as Record<string, unknown>).attributes);

  const payload: ProviderAuthSecretPayload = {};
  if (accessToken !== null) payload.accessToken = accessToken;
  if (refreshToken !== null) payload.refreshToken = refreshToken;
  if (apiKey !== null) payload.apiKey = apiKey;
  if (accountId !== null) payload.accountId = accountId;
  if (projectId !== null) payload.projectId = projectId;
  if (expiresAt !== undefined) payload.expiresAt = expiresAt;
  if (baseUrl !== null) payload.baseUrl = baseUrl;
  if (rawMetadata !== undefined) payload.rawMetadata = rawMetadata;
  if (rawAttributes !== undefined) payload.rawAttributes = rawAttributes;

  // Kiro IDE specific: lift the AWS CodeWhisperer profile ARN onto
  // its own field so the adapter can derive the regional API host
  // (`q.<region>.amazonaws.com`) without re-parsing `rawMetadata`.
  // The field name is `profileArn` in `~/.aws/sso/cache/kiro-auth-token.json`.
  if (provider === 'kiro-ide') {
    const profileArn = findFirstString(parsed, [['profileArn']]);
    if (profileArn !== null) payload.kiroProfileArn = profileArn;
    // `authMethod` selects which OAuth refresh endpoint the
    // `kiro-ide.adapter` hits. We hoist it onto a first-class
    // payload field for the same reason we hoist `profileArn`:
    // the adapter must not re-parse `rawMetadata` to discover it.
    const authMethod = findFirstString(parsed, [['authMethod']]);
    if (authMethod !== null) payload.kiroAuthMethod = authMethod;
  }

  // Label derivation: metadata.label → attributes.label → email →
  // accountId → '<provider>:imported'. Email beats accountId so the
  // UI shows e.g. `alice@example.com` instead of an opaque
  // `auth0|abc123` (Codex) or a Google `numericId` (Gemini /
  // Antigravity). The last fallback is intentionally non-unique;
  // the service layer enriches it with a UUID suffix.
  const explicitLabel = findFirstString(parsed, LABEL_PATHS);
  // Email resolution: explicit `email` field first (handles CPA
  // exports that surface it under metadata / attributes), then the
  // OIDC `id_token` JWT (handles Codex `tokens.id_token` and
  // Gemini / Antigravity `metadata.id_token` / `id_token`).
  const email =
    findFirstString(parsed, EMAIL_PATHS) ?? findEmailFromIdTokens(parsed);
  const label =
    explicitLabel ??
    email ??
    accountId ??
    `${provider}:imported`;

  return {
    label,
    accountId: accountId,
    projectId: projectId,
    email,
    payload,
  };
}
