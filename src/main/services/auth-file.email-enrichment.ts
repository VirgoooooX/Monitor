// Best-effort email enrichment for Google OAuth credentials.
//
// Gemini CLI and Antigravity auth files (whether the canonical CPA
// export or the native `~/.gemini/oauth_creds.json` /
// `~/.antigravity/oauth_creds.json`) carry an `access_token` with
// the `userinfo.email` scope, but no `id_token` and no inline
// `email` field. There is no other on-disk path to the account
// email, which is why the auto-discovery flow used to surface
// Google project ids (`vivid-course-453615-u9`) as the only
// human-readable identifier.
//
// This module fetches the email by calling Google's standard
// `tokeninfo` / `userinfo` endpoint. The lookup is:
//
//   - bounded (3 second timeout, response capped by `requestJson`)
//   - best-effort (any failure is swallowed; the import still
//     succeeds with the existing label, just without the email)
//   - opt-in per provider (only `gemini-cli` and `antigravity` —
//     other providers either already surface the email or have
//     no equivalent endpoint we can call without surface-area)
//   - idempotent (the result is stamped into the parsed payload's
//     `rawMetadata.email` so subsequent re-scans skip the network
//     call entirely)
//
// We deliberately do NOT persist the email separately — the
// existing `chooseRefreshLabel` logic in `auth-file.discovery.ts`
// promotes `parsed.email` to `provider_auth.label`, and the
// fingerprint set already keys off the email block.

import type { ProviderId } from '../types';
import { requestJson } from './quota/adapters/common';
import type { ParseResult } from './auth-file.parser';

const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const ENRICH_TIMEOUT_MS = 3000;

/**
 * Function shape that performs the email lookup. Pulled out as an
 * interface so tests can inject a deterministic stub without
 * spinning up the real `https` transport.
 */
export type FetchEmailForAccessToken = (input: {
  readonly accessToken: string;
  readonly signal?: AbortSignal;
}) => Promise<string | null>;

/**
 * Default implementation — calls Google's OIDC userinfo endpoint
 * (`https://openidconnect.googleapis.com/v1/userinfo`) with the
 * access token as a Bearer credential. Any error (network, 4xx,
 * malformed body) resolves to `null` so callers can treat the
 * lookup as best-effort.
 */
export const fetchGoogleEmailForAccessToken: FetchEmailForAccessToken = async ({
  accessToken,
  signal,
}) => {
  try {
    const response = await requestJson<{ email?: unknown }>({
      url: GOOGLE_USERINFO_URL,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      timeoutMs: ENRICH_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (
      typeof response.email === 'string' &&
      response.email.trim().length > 0
    ) {
      return response.email.trim();
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Returns `true` for providers whose CPA / on-disk auth files do
 * not surface an email but where one is reachable from the access
 * token. v1 covers the Google Code Assist family (`gemini-cli`,
 * `antigravity`) — Codex already carries the email in its
 * `id_token`, Claude Code OAuth has no userinfo endpoint we can
 * reuse, and the manual API-key providers have no notion of an
 * "account email" at all.
 */
function providerSupportsEmailEnrichment(provider: ProviderId): boolean {
  return provider === 'gemini-cli' || provider === 'antigravity';
}

/**
 * Mutate `parsed` in place with the email recovered from the
 * provider's userinfo endpoint when:
 *
 *   1. The provider supports enrichment ({@link providerSupportsEmailEnrichment}).
 *   2. The parser did not already extract an email.
 *   3. We have a non-empty access token to authenticate the lookup.
 *   4. The userinfo call succeeds.
 *
 * The function is fire-and-forget on every failure mode; the
 * caller is responsible for nothing more than awaiting the
 * promise. `parsed.label` is promoted to the email when the prior
 * label was the parser's `<provider>:imported` fallback or one of
 * the ugly opaque ids; otherwise we leave the label alone so a
 * deliberate `metadata.label` survives.
 */
export async function enrichParseResultWithEmail(
  provider: ProviderId,
  parsed: ParseResult,
  fetchEmail: FetchEmailForAccessToken = fetchGoogleEmailForAccessToken,
): Promise<void> {
  if (!providerSupportsEmailEnrichment(provider)) return;
  if (typeof parsed.email === 'string' && parsed.email.trim().length > 0) return;
  const accessToken =
    typeof parsed.payload.accessToken === 'string'
      ? parsed.payload.accessToken.trim()
      : '';
  if (accessToken.length === 0) return;

  const email = await fetchEmail({ accessToken });
  if (email === null) return;

  // Stamp the email onto the parsed result so:
  //   - `discovery.fingerprintsForCandidate` produces an email
  //     fingerprint and dedupes identical accounts imported via
  //     different files;
  //   - `chooseRefreshLabel` upgrades pre-existing rows.
  parsed.email = email;

  // Also seed `rawMetadata.email` so the next time the same file
  // is scanned the parser's `EMAIL_PATHS` resolves directly and
  // the network call is skipped. We only attach `rawMetadata`
  // when we're sure it won't clobber a hand-written value.
  const existing = parsed.payload.rawMetadata;
  if (existing === undefined) {
    parsed.payload.rawMetadata = { email };
  } else if (typeof existing['email'] !== 'string' || existing['email'].length === 0) {
    parsed.payload.rawMetadata = { ...existing, email };
  }

  // Promote the label only when it's an auto-derived ugly value.
  // Same heuristic as `chooseRefreshLabel` so re-scan and first-
  // time discovery agree on what counts as upgradeable.
  const label = typeof parsed.label === 'string' ? parsed.label : '';
  const looksLikeAccountId =
    parsed.accountId !== null && label === parsed.accountId;
  const looksLikeProjectId =
    parsed.projectId !== null && label === parsed.projectId;
  const looksLikeFallback = label.startsWith(`${provider}:imported`);
  if (label.length === 0 || looksLikeAccountId || looksLikeProjectId || looksLikeFallback) {
    parsed.label = email;
  }
}
