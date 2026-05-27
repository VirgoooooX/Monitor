// Kiro IDE OAuth refresh-token exchange.
//
// Two distinct refresh paths backed by the same `kiro-auth-token.json`
// file (see `kiro-ide.adapter.ts` for the file shape):
//
//   1. `authMethod === 'social'` — user signed in through Google /
//      GitHub / Microsoft via the Kiro Desktop Auth flow. The IDE
//      hits:
//
//        POST https://prod.<region>.auth.desktop.kiro.dev/refreshToken
//        Content-Type: application/json
//        body: {"refreshToken": "<rt>"}
//
//      Response: `{accessToken, refreshToken, expiresIn, profileArn?}`
//
//   2. `authMethod === 'sso' | 'idc'` — corporate IAM Identity
//      Center login. Refresh hits AWS SSO OIDC's `CreateToken`
//      with the device-registration credentials persisted alongside
//      the auth file. v1 does NOT auto-refresh this path because the
//      `clientId` / `clientSecret` live in a sibling
//      `<clientIdHash>.json` we don't yet read; the adapter falls
//      back to the existing "凭据已过期" prompt instead.
//
// Refresh tokens rotate on every successful exchange — the response's
// new `refreshToken` invalidates the one we just sent. The adapter is
// responsible for persisting the new triple back to (a) the encrypted
// `secrets` row and (b) (optionally) the source `kiro-auth-token.json`
// so the IDE keeps using the same chain.
//
// Errors map to typed `ProviderAdapterError` codes:
//   - HTTP 400 / 401 / 403 → `auth_expired` (RT chain is dead;
//     re-import is the only recovery)
//   - HTTP 5xx / network errors / parse failures → `network_error`
//     (transient — adapter falls back to the existing access token
//     until it actually expires)

import {
  ProviderAdapterError,
  asFiniteNumber,
  asRecord,
  type RequestJson,
} from './common';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type KiroAuthMethod = 'social' | 'sso' | 'idc' | 'aws-sso';

export interface KiroTokenRefreshInput {
  /** Verbatim `refreshToken` value from the secret payload. */
  readonly refreshToken: string;
  /**
   * `authMethod` field from the source `kiro-auth-token.json`. When
   * absent we default to `'social'` — that is what the desktop IDE
   * writes by default and matches the social-login flow this v1
   * supports.
   */
  readonly authMethod: KiroAuthMethod | null;
  /**
   * AWS region segment, already extracted from the user's
   * `profileArn`. Whitelisted by `resolveRegion` in the parent
   * adapter so we never let a malformed ARN drive the refresh
   * request to an attacker-controlled host.
   */
  readonly region: string;
}

export interface KiroTokenRefreshResult {
  readonly accessToken: string;
  /**
   * The server may or may not rotate the refresh token. The Kiro
   * Desktop Auth endpoint always returns a fresh value; we mirror
   * the input verbatim if the field is missing for forward-compat
   * with future server changes.
   */
  readonly refreshToken: string;
  /** Epoch ms — already adjusted for the {@link EXPIRY_SKEW_MS} buffer. */
  readonly expiresAt: number;
  /**
   * The `profileArn` returned by the refresh endpoint when present.
   * Some endpoints echo it back; others omit it. The adapter keeps
   * the existing payload value when this is null.
   */
  readonly profileArn: string | null;
}

export interface KiroTokenRefreshDeps {
  readonly requestJson: RequestJson;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Buffer subtracted from server-reported `expiresIn` so the adapter
 * never hands an access token back to the request layer that is
 * about to expire mid-flight. 60 seconds matches the rest of the
 * codebase (`google-code-assist.ts#TOKEN_EXPIRY_SKEW_MS`).
 */
const EXPIRY_SKEW_MS = 60 * 1000;

/**
 * Default `expiresIn` (1 hour) when the server omits the field.
 * The Kiro Desktop Auth endpoint always populates it, but we accept
 * the absence defensively.
 */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * `User-Agent` string sent with every refresh request. The IDE itself
 * uses `KiroIDE-<version>-<machineId>`; we send a stable, harmless
 * marker that's identifiable in the auth-service's audit logs without
 * leaking machine identity.
 */
const REFRESH_USER_AGENT = 'KiroIDE-monitor';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for a fresh access token.
 *
 * @throws {ProviderAdapterError} `auth_expired` — RT rejected (400/401/403).
 * @throws {ProviderAdapterError} `network_error` — transient (5xx, timeout).
 * @throws {ProviderAdapterError} `unsupported` — auth method we don't yet handle (e.g. `'sso'`).
 */
export async function refreshKiroToken(
  input: KiroTokenRefreshInput,
  deps: KiroTokenRefreshDeps,
): Promise<KiroTokenRefreshResult> {
  const refreshToken = input.refreshToken.trim();
  if (refreshToken.length === 0) {
    throw new ProviderAdapterError(
      'auth_expired',
      'Kiro IDE refresh token is empty',
    );
  }

  const method: KiroAuthMethod = (input.authMethod ?? 'social') as KiroAuthMethod;

  if (method !== 'social') {
    // SSO / IAM Identity Center: refresh requires the
    // `clientId` / `clientSecret` from the sibling
    // `<clientIdHash>.json` device-registration file. Out of scope
    // for v1 — the adapter surfaces this as the existing
    // "凭据已过期" prompt and the user re-authenticates from the
    // IDE.
    throw new ProviderAdapterError(
      'unsupported',
      `Kiro IDE auth method '${method}' is not auto-refreshable (re-import from CPA)`,
    );
  }

  return refreshKiroTokenSocial(refreshToken, input.region, deps);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Build the regional Kiro Desktop Auth refresh URL. Mirrors the
 * `prod.<region>.auth.desktop.kiro.dev` host that the IDE itself
 * uses (per Kiro's published firewall allowlist).
 */
export function buildSocialRefreshUrl(region: string): string {
  return `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
}

interface SocialRefreshResponse {
  readonly accessToken?: unknown;
  readonly refreshToken?: unknown;
  readonly expiresIn?: unknown;
  readonly profileArn?: unknown;
}

async function refreshKiroTokenSocial(
  refreshToken: string,
  region: string,
  deps: KiroTokenRefreshDeps,
): Promise<KiroTokenRefreshResult> {
  const url = buildSocialRefreshUrl(region);

  let response: SocialRefreshResponse;
  try {
    response = await deps.requestJson<SocialRefreshResponse>({
      url,
      method: 'POST',
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': REFRESH_USER_AGENT,
      },
      body: { refreshToken },
    });
  } catch (err) {
    throw normaliseRefreshError(err);
  }

  return parseSocialRefreshResponse(response, refreshToken, deps.now());
}

/**
 * Validate and shape the social-flow refresh response. Exported for
 * test coverage; the runtime path always reaches this through
 * {@link refreshKiroToken}.
 */
export function parseSocialRefreshResponse(
  response: unknown,
  fallbackRefreshToken: string,
  now: number,
): KiroTokenRefreshResult {
  const root = asRecord(response);
  if (root === null) {
    throw new ProviderAdapterError(
      'network_error',
      'Kiro IDE refresh response was not an object',
    );
  }

  const accessToken =
    typeof root['accessToken'] === 'string'
      ? (root['accessToken'] as string).trim()
      : '';
  if (accessToken.length === 0) {
    throw new ProviderAdapterError(
      'network_error',
      'Kiro IDE refresh response missing accessToken',
    );
  }

  const rotatedRefreshToken =
    typeof root['refreshToken'] === 'string'
      ? (root['refreshToken'] as string).trim()
      : '';
  const nextRefreshToken =
    rotatedRefreshToken.length > 0 ? rotatedRefreshToken : fallbackRefreshToken;

  const expiresInSeconds =
    asFiniteNumber(root['expiresIn']) ?? DEFAULT_EXPIRES_IN_SECONDS;
  const expiresAt = now + expiresInSeconds * 1000 - EXPIRY_SKEW_MS;

  const profileArn =
    typeof root['profileArn'] === 'string' &&
    (root['profileArn'] as string).trim().length > 0
      ? (root['profileArn'] as string).trim()
      : null;

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt,
    profileArn,
  };
}

/**
 * Map a thrown error from the underlying transport to a typed
 * `ProviderAdapterError`. The transport already wraps HTTP / network
 * failures in `ProviderAdapterError`; we just re-stamp their `code`
 * to make the auth-vs-transient distinction explicit at this layer.
 */
function normaliseRefreshError(err: unknown): ProviderAdapterError {
  if (err instanceof ProviderAdapterError) {
    if (
      err.code === 'upstream_unauthorized' ||
      err.code === 'upstream_changed' ||
      err.code === 'auth_expired'
    ) {
      // 400 invalid_grant / 401 / 403 / parse failure with a 4xx-shaped
      // body all imply the RT chain has been broken upstream. Treat
      // them all as `auth_expired` so the renderer surfaces the
      // re-import prompt rather than retrying forever.
      return new ProviderAdapterError(
        'auth_expired',
        'Kiro IDE refresh token rejected',
      );
    }
    return err;
  }
  return new ProviderAdapterError(
    'network_error',
    'Kiro IDE refresh request failed',
  );
}

/**
 * Convenience accessor for tests that need to construct a fake
 * response without reaching into private constants.
 */
export const KIRO_REFRESH_INTERNALS = {
  EXPIRY_SKEW_MS,
  DEFAULT_EXPIRES_IN_SECONDS,
  REFRESH_USER_AGENT,
} as const;
