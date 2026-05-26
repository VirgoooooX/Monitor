// Secrets module backed by Electron `safeStorage` (DPAPI on Windows,
// Keychain on macOS, kwallet/libsecret on Linux).
//
// Design references:
//   - design.md §`secrets.set`, §`secrets.get` (formal pre/postconditions)
//   - design.md §SQLite Schema (the `secrets` table holds ciphertext only)
//   - design.md §Property 10 (round-trip + ciphertext != plaintext bytes)
//   - PLAN.md §Data Protection (no plaintext on disk; key-like fields
//     redacted from any export)
//
// This file is intentionally free of `import('electron')` at module
// top-level so it can be unit-tested without Electron and so the file
// loads cleanly under the renderer-side type-checker (which never
// imports it but shares the same project graph). The runtime
// `safeStorage` instance is injected by `app.ts` via `initSecrets`.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of Electron's `safeStorage`. Matches
 * `Electron.SafeStorage`'s relevant surface so the real instance is
 * assignable without a type cast.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Tiny backing-store contract. `repositories.ts` (task 1.4) will
 * implement this against the SQLite `secrets` table; tests can supply
 * an in-memory map.
 *
 * `getEncrypted` returns `null` when no row exists for `key`.
 */
export interface SecretsStore {
  getEncrypted(key: string): Buffer | null;
  setEncrypted(key: string, value: Buffer): void;
  deleteByKey(key: string): void;
}

/** Public API exposed by the module. */
export interface SecretsModule {
  /** Wraps `safeStorage.isEncryptionAvailable()`. Never throws. */
  isAvailable(): boolean;
  /**
   * Encrypt `plaintext` and persist the ciphertext at `key`.
   *
   * @throws {SecretsUnavailableError} when OS-level encryption is unavailable.
   */
  set(key: string, plaintext: string): void;
  /**
   * Return the original plaintext for `key`, or `null` when no row exists.
   *
   * @throws {SecretsUnavailableError} when OS-level encryption is unavailable.
   * @throws {SecretsDecryptError} when ciphertext exists but cannot be
   *   decrypted (typically because the OS encryption key has rotated).
   */
  get(key: string): string | null;
  /** Idempotent delete; safe to call when no row exists. */
  remove(key: string): void;
}

export interface SecretsDeps {
  store: SecretsStore;
  safeStorage: SafeStorageLike;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `set` and `get` when `safeStorage.isEncryptionAvailable()`
 * is `false` (e.g. headless Linux without kwallet/libsecret, or a
 * corrupted user profile on Windows).
 *
 * Distinguishable across an IPC boundary via `error.name`.
 */
export class SecretsUnavailableError extends Error {
  public override readonly name = 'SecretsUnavailableError';

  public constructor(
    message = 'safeStorage encryption is not available on this OS profile',
  ) {
    super(message);
  }
}

/**
 * Thrown by `get` when ciphertext exists for a key but
 * `safeStorage.decryptString` fails — typically caused by OS encryption
 * key rotation (e.g. Windows DPAPI master key reset). The original key
 * name is preserved (it is non-sensitive); the ciphertext and any
 * cause-message are *not* propagated, in case they could surface
 * plaintext fragments via memory.
 */
export class SecretsDecryptError extends Error {
  public override readonly name = 'SecretsDecryptError';
  public readonly key: string;

  public constructor(key: string) {
    super(
      `failed to decrypt secret for key "${key}" ` +
        '(ciphertext is unreadable; the OS encryption key may have rotated)',
    );
    this.key = key;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function assertNonEmptyKey(method: string, key: string): string {
  // Validate before touching the store so callers get a deterministic
  // error class. We never echo the value of any *secret* in messages,
  // but the *key* is non-sensitive (e.g. `openclash.controllerSecret`).
  if (typeof key !== 'string') {
    throw new TypeError(`${method}: key must be a string`);
  }
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${method}: key must be a non-empty string`);
  }
  return trimmed;
}

/**
 * Build a `SecretsModule` against an explicit dependency pair. Use this
 * directly in tests; production code goes through `initSecrets` /
 * `secrets`.
 */
export function createSecretsModule(deps: SecretsDeps): SecretsModule {
  const { store, safeStorage } = deps;

  function requireAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new SecretsUnavailableError();
    }
  }

  return {
    isAvailable(): boolean {
      // Wrap defensively: a misbehaving SafeStorage shim that throws
      // here would crash window paint paths that probe availability.
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },

    set(key: string, plaintext: string): void {
      const k = assertNonEmptyKey('secrets.set', key);
      requireAvailable();

      let ciphertext: Buffer;
      try {
        ciphertext = safeStorage.encryptString(plaintext);
      } catch (cause) {
        // Defensive: OS-level encryption failures should never echo
        // plaintext, but we strip the cause's message anyway so a
        // stray plaintext fragment cannot escape into logs.
        const causeName = cause instanceof Error ? cause.name : 'Error';
        throw new Error(`secrets.set: encryption failed (${causeName})`);
      }

      store.setEncrypted(k, ciphertext);
    },

    get(key: string): string | null {
      const k = assertNonEmptyKey('secrets.get', key);
      requireAvailable();

      const ciphertext = store.getEncrypted(k);
      if (ciphertext === null) {
        return null;
      }

      try {
        return safeStorage.decryptString(ciphertext);
      } catch {
        // Do NOT thread the underlying error message through:
        // a corrupted blob could in principle decrypt to a fragment of
        // plaintext that lands inside the OS error message.
        throw new SecretsDecryptError(k);
      }
    },

    remove(key: string): void {
      const k = assertNonEmptyKey('secrets.remove', key);
      // No availability check: removing ciphertext is always safe and
      // is in fact the recovery path when encryption has become
      // unavailable on this profile.
      store.deleteByKey(k);
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton accessor (used by the rest of `main`)
// ---------------------------------------------------------------------------

let _module: SecretsModule | null = null;

/**
 * Wire the singleton. Called once during `app.ts` boot, after the DB
 * is open and the secrets repository has been constructed.
 */
export function initSecrets(deps: SecretsDeps): void {
  _module = createSecretsModule(deps);
}

/** Test/teardown helper. Not used in production. */
export function resetSecretsForTests(): void {
  _module = null;
}

function requireModule(method: string): SecretsModule {
  if (_module === null) {
    throw new Error(
      `${method}: secrets module is not initialized; ` +
        'call initSecrets({ store, safeStorage }) during app boot',
    );
  }
  return _module;
}

/**
 * Public accessor used by services (`openclash.service`,
 * `deepseek.collector`, `diagnostics.service`). Mirrors the
 * `SecretsModule` shape but lazy-resolves through the singleton so
 * importers do not need to thread the module instance around.
 *
 * `isAvailable()` is the only method that is safe to call before
 * `initSecrets`; it returns `false` instead of throwing so UI code
 * can render a "credential storage unavailable" state during boot.
 */
export const secrets: SecretsModule = {
  isAvailable(): boolean {
    return _module?.isAvailable() ?? false;
  },
  set(key: string, plaintext: string): void {
    requireModule('secrets.set').set(key, plaintext);
  },
  get(key: string): string | null {
    return requireModule('secrets.get').get(key);
  },
  remove(key: string): void {
    requireModule('secrets.remove').remove(key);
  },
};
