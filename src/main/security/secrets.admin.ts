// Main-only secrets accessor for Provider_Auth flows.
//
// References:
//   - design.md §`secrets` (existing table, key allowlist extended)
//   - design.md §Trust Boundaries (renderer never sees Provider_Auth secrets)
//   - requirements.md §Requirement 15 (Secret Allowlist 扩展)
//   - tasks.md §3.2 (Extend the main-side secret-key allowlist)
//
// =============================================================================
// SECURITY MODEL — READ BEFORE TOUCHING THIS FILE
// =============================================================================
//
// The renderer-facing IPC callbacks (`updateSecret` / `getSecret` /
// `removeSecret` in `src/main/app.ts`) MUST keep their closed allowlist of
// three fixed keys:
//
//     openclash.controllerSecret
//     openclash.management.username
//     openclash.management.password
//
// Adding `cpaAuth.providerAuth.<uuid>` to those allowlists would let a
// compromised renderer overwrite an existing Provider_Auth secret with
// attacker-supplied content, defeating the entire import-flow trust model
// (design.md §Trust Boundaries).
//
// This module supplies a SEPARATE, MAIN-ONLY accessor — never exposed via
// IPC — that augments the renderer-facing allowlist with keys matching:
//
//     ^cpaAuth\.providerAuth\.[0-9a-f-]{36}$
//
// (UUIDv4 form, as written by `Provider_Auth_Service.importFromFile`.)
//
// Callers:
//   - `provider_auth.service.ts`  — import / delete flows
//   - `quota.service.ts`          — lazy-decrypt closures during refresh
//
// Anything else (collectors, dashboard, IPC handlers reachable from the
// renderer) MUST go through the existing `secrets` singleton or the
// `updateSecret`-style IPC callbacks, NOT through this admin wrapper.
//
// Per Requirement 15.3, an unknown key throws an `Error` whose message
// contains only the key name and the wrapper identity — no values, no
// stack-trace fragments, no plaintext.
//
// =============================================================================

import type { SecretsModule } from './secrets';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Main-only accessor over the encrypted secrets store. Mirrors the
 * shape of `SecretsModule.set` / `get` / `remove` but accepts an
 * extended allowlist (the three OpenClash keys PLUS the
 * `cpaAuth.providerAuth.<uuid>` family).
 *
 * NEVER export this object across an IPC boundary. The construction
 * site (`app.ts`) holds the only reference and threads it into
 * services via `deps.secretsAdmin`.
 */
export interface SecretsAdmin {
  /**
   * Encrypt `plaintext` and persist it at `key`.
   * @throws when `key` is not on the extended allowlist.
   * @throws {SecretsUnavailableError} from the underlying module when
   *   OS encryption is unavailable.
   */
  set(key: string, plaintext: string): void;

  /**
   * Return the original plaintext for `key`, or `null` when no row
   * exists.
   * @throws when `key` is not on the extended allowlist.
   * @throws {SecretsUnavailableError} from the underlying module when
   *   OS encryption is unavailable.
   * @throws {SecretsDecryptError} from the underlying module when
   *   ciphertext exists but cannot be decrypted.
   */
  get(key: string): string | null;

  /**
   * Idempotent delete; safe to call when no row exists.
   * @throws when `key` is not on the extended allowlist.
   */
  remove(key: string): void;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Fixed keys shared with the renderer-facing `updateSecret` /
 * `getSecret` / `removeSecret` allowlists. Kept in sync by hand —
 * if a new fixed key is added in `app.ts`, mirror it here.
 *
 * The Provider_Auth dynamic family is matched separately by
 * {@link PROVIDER_AUTH_KEY_RE} and is NOT included in this list.
 */
const FIXED_ADMIN_KEYS: readonly string[] = [
  'openclash.controllerSecret',
  'openclash.management.username',
  'openclash.management.password',
];

/**
 * Per design.md §`secrets` (existing table, key allowlist extended)
 * and Requirement 15.1: every Provider_Auth secret key has the form
 * `cpaAuth.providerAuth.<uuid>`, where `<uuid>` is the
 * `provider_auth.id` UUIDv4.
 *
 * The pattern accepts any 36-char `[0-9a-f-]` sequence (the canonical
 * lower-case UUIDv4 form `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` and
 * is intentionally tolerant of UUID variant bits — `crypto.randomUUID`
 * always produces a valid v4 in this character class).
 */
const PROVIDER_AUTH_KEY_RE = /^cpaAuth\.providerAuth\.[0-9a-f-]{36}$/;

function assertAllowed(key: string): void {
  if (FIXED_ADMIN_KEYS.includes(key)) return;
  if (PROVIDER_AUTH_KEY_RE.test(key)) return;
  // Echo only the key name (key names are non-sensitive — plaintext
  // values never reach this code path because the disallowed call is
  // rejected before the underlying `secrets.set` runs).
  throw new Error(`secretsAdmin: unknown key '${key}'`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link SecretsAdmin} on top of the supplied `secrets`
 * module. The wrapper performs the allowlist check before
 * delegating; allowlist failures throw before any side-effect
 * touches the store.
 *
 * The returned object has no other capabilities — it is the entire
 * surface area exposed to `Provider_Auth_Service` and `QuotaService`
 * for secret access.
 */
export function createSecretsAdmin(secrets: SecretsModule): SecretsAdmin {
  return {
    set(key, plaintext) {
      assertAllowed(key);
      secrets.set(key, plaintext);
    },
    get(key) {
      assertAllowed(key);
      return secrets.get(key);
    },
    remove(key) {
      assertAllowed(key);
      secrets.remove(key);
    },
  };
}
