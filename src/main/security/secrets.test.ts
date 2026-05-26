// Secrets module unit tests.
//
// Covers:
//   - Round-trip: set → get returns original plaintext
//   - get returns null for missing keys
//   - Encryption unavailable throws SecretsUnavailableError
//   - Ciphertext != plaintext (Property 10)
//   - remove is idempotent

import { describe, it, expect } from 'vitest';
import {
  createSecretsModule,
  SecretsUnavailableError,
  SecretsDecryptError,
  type SecretsStore,
  type SafeStorageLike,
} from './secrets';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple in-memory store + "encryption" (just reverses the string
 * so ciphertext != plaintext while being deterministic).
 */
function createTestDeps(opts?: { available?: boolean }): {
  store: SecretsStore;
  safeStorage: SafeStorageLike;
} {
  const map = new Map<string, Buffer>();
  const available = opts?.available ?? true;

  return {
    store: {
      getEncrypted(key) {
        return map.get(key) ?? null;
      },
      setEncrypted(key, value) {
        map.set(key, value);
      },
      deleteByKey(key) {
        map.delete(key);
      },
    },
    safeStorage: {
      isEncryptionAvailable() {
        return available;
      },
      encryptString(plainText: string): Buffer {
        // Fake "encryption": reverse + base64 so it's clearly different
        const reversed = plainText.split('').reverse().join('');
        return Buffer.from(reversed, 'utf-8');
      },
      decryptString(encrypted: Buffer): string {
        const reversed = encrypted.toString('utf-8');
        return reversed.split('').reverse().join('');
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('secrets module', () => {
  it('round-trips a secret value', () => {
    const deps = createTestDeps();
    const mod = createSecretsModule(deps);

    mod.set('my.key', 'hello-world');
    expect(mod.get('my.key')).toBe('hello-world');
  });

  it('returns null for a missing key', () => {
    const deps = createTestDeps();
    const mod = createSecretsModule(deps);

    expect(mod.get('nonexistent')).toBeNull();
  });

  it('ciphertext is not equal to plaintext bytes (Property 10)', () => {
    const deps = createTestDeps();
    const mod = createSecretsModule(deps);
    const plaintext = 'my-secret-value';

    mod.set('key', plaintext);

    // Access the raw store to verify ciphertext != plaintext
    const stored = deps.store.getEncrypted('key');
    expect(stored).not.toBeNull();
    expect(stored!.toString('utf-8')).not.toBe(plaintext);
  });

  it('throws SecretsUnavailableError when encryption is unavailable (set)', () => {
    const deps = createTestDeps({ available: false });
    const mod = createSecretsModule(deps);

    expect(() => mod.set('k', 'v')).toThrow(SecretsUnavailableError);
  });

  it('throws SecretsUnavailableError when encryption is unavailable (get)', () => {
    const deps = createTestDeps({ available: false });
    const mod = createSecretsModule(deps);

    expect(() => mod.get('k')).toThrow(SecretsUnavailableError);
  });

  it('remove is idempotent', () => {
    const deps = createTestDeps();
    const mod = createSecretsModule(deps);

    mod.set('k', 'v');
    mod.remove('k');
    mod.remove('k'); // second call should not throw
    expect(mod.get('k')).toBeNull();
  });

  it('isAvailable returns false when unavailable', () => {
    const deps = createTestDeps({ available: false });
    const mod = createSecretsModule(deps);

    expect(mod.isAvailable()).toBe(false);
  });

  it('isAvailable returns true when available', () => {
    const deps = createTestDeps({ available: true });
    const mod = createSecretsModule(deps);

    expect(mod.isAvailable()).toBe(true);
  });
});
