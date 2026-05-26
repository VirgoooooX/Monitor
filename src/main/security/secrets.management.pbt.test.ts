// Feature: network-quick-actions, Property 9
//
// Property 9: Management credential round-trip via safeStorage.
// Validates: Requirements 12.1
//
// For every pair of non-empty UTF-16 strings (u, p):
//   1. secrets.set + secrets.get round-trips u under
//      `openclash.management.username`.
//   2. Same for p under `openclash.management.password`.
//   3. The raw bytes stored in the `secrets` table for either row are
//      NOT equal to the UTF-8 bytes of the plaintext (i.e. the row is
//      ciphertext, not the plaintext value).
//
// Test fixture uses a deterministic byte-wise XOR-0xAA "encryption" as
// a stand-in for Electron's `safeStorage`. XOR with a non-zero mask
// flips every input byte, so for any non-empty plaintext the ciphertext
// bytes are guaranteed to differ from the plaintext bytes — the
// in-test analogue of the real DPAPI / Keychain / libsecret guarantee.

import { describe, it, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  initSecrets,
  resetSecretsForTests,
  secrets,
  type SafeStorageLike,
  type SecretsStore,
} from './secrets';

const USERNAME_KEY = 'openclash.management.username';
const PASSWORD_KEY = 'openclash.management.password';

const ENCRYPTION_MASK = 0xaa;

function makeXorSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable(): boolean {
      return true;
    },
    encryptString(plainText: string): Buffer {
      const src = Buffer.from(plainText, 'utf-8');
      const out = Buffer.alloc(src.length);
      for (let i = 0; i < src.length; i += 1) {
        out[i] = src[i] ^ ENCRYPTION_MASK;
      }
      return out;
    },
    decryptString(encrypted: Buffer): string {
      const out = Buffer.alloc(encrypted.length);
      for (let i = 0; i < encrypted.length; i += 1) {
        out[i] = encrypted[i] ^ ENCRYPTION_MASK;
      }
      return out.toString('utf-8');
    },
  };
}

function makeStore(): { store: SecretsStore; map: Map<string, Buffer> } {
  const map = new Map<string, Buffer>();
  return {
    map,
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
  };
}

describe('secrets module — Property 9 (network-quick-actions)', () => {
  afterEach(() => {
    resetSecretsForTests();
  });

  it('round-trips management credentials and stores ciphertext, not plaintext', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (u, p) => {
          const { store, map } = makeStore();
          const safeStorage = makeXorSafeStorage();

          resetSecretsForTests();
          initSecrets({ store, safeStorage });

          // (1) Write both management credentials through the singleton.
          secrets.set(USERNAME_KEY, u);
          secrets.set(PASSWORD_KEY, p);

          // (2) Round-trip read via the public getter must return the
          //     original plaintext for both keys.
          if (secrets.get(USERNAME_KEY) !== u) {
            return false;
          }
          if (secrets.get(PASSWORD_KEY) !== p) {
            return false;
          }

          // (3) The raw row bytes the store sees must NOT equal the
          //     UTF-8 plaintext — i.e. the column holds ciphertext.
          const rawUsername = map.get(USERNAME_KEY);
          const rawPassword = map.get(PASSWORD_KEY);
          if (rawUsername === undefined || rawPassword === undefined) {
            return false;
          }
          if (rawUsername.equals(Buffer.from(u, 'utf-8'))) {
            return false;
          }
          if (rawPassword.equals(Buffer.from(p, 'utf-8'))) {
            return false;
          }

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
