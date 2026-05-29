// Feature: macos-platform-support, Property 11
//
// Property 11: Secrets propagate underlying encryption errors unchanged;
// never swallow, never retry, never fall back to plaintext.
//
// Validates: Requirements 10.3, 10.4, 10.5
//
// For any error `E` thrown by `safeStorage.encryptString` /
// `safeStorage.decryptString`:
//
//   * `secrets.set(key, plaintext)` / `secrets.get(key)` MUST throw a
//     visible error to the caller (never swallow).
//   * `safeStorage.encryptString` / `safeStorage.decryptString` MUST be
//     invoked exactly once per call (never retry).
//   * The backing store MUST NOT receive the plaintext as a fallback
//     (never fall back to plaintext).
//   * For `set`: the wrapped message names the underlying error class
//     (`TypeError`, `RangeError`, etc.) but does NOT echo the cause
//     message — `secrets.ts` strips it deliberately to avoid leaking
//     plaintext fragments through OS error strings.
//   * For `get`: the thrown error is a `SecretsDecryptError` carrying
//     the key name; the original cause is intentionally not threaded
//     through, again to avoid leaking plaintext (design.md §Property
//     11 wording).
//
// The test composes its own dependency pair via `createSecretsModule`
// instead of going through `initSecrets` / the singleton, so two
// concurrent property runs never share state through the module-level
// `_module` cache.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  createSecretsModule,
  SecretsDecryptError,
  type SafeStorageLike,
  type SecretsStore,
} from './secrets';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Cause messages carry a distinctive marker prefix that is guaranteed
 * not to appear anywhere in `secrets.ts`'s wrapper boilerplate. The
 * property under test ("wrapper does not echo the cause's message")
 * is only meaningful when the cause message is unambiguous — a bare
 * space character is a substring of every English wrapper string and
 * trivially fails substring containment without indicating any real
 * leakage. We attach the marker to the *random* portion so the
 * leakage check stays sharp regardless of the fuzzed payload.
 */
const CAUSE_MARKER = '__CAUSE_LEAK_MARKER__';

const causeMessageArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .map((s) => `${CAUSE_MARKER}${s}`);

/**
 * A diverse error generator so the property exercises every common
 * error class shape: `Error`, the standard subclasses, and an `Error`
 * decorated with a syscall-style `code` (which `safeStorage` itself
 * sometimes raises on a corrupted user profile).
 */
const errorArb: fc.Arbitrary<Error> = fc.oneof(
  causeMessageArb.map((m) => new Error(m)),
  causeMessageArb.map((m) => new TypeError(m)),
  causeMessageArb.map((m) => new RangeError(m)),
  causeMessageArb.map((m) => new SyntaxError(m)),
  causeMessageArb.map((m) => {
    const err = new Error(m) as Error & { code?: string };
    err.code = 'EACCES';
    return err;
  }),
);

/** Non-empty key. The key is required to be a non-empty trimmed string. */
const keyArb = fc.string({ minLength: 1, maxLength: 64 }).filter(
  (s) => s.trim().length > 0,
);

/**
 * Plaintext carries a distinctive marker so the "no plaintext leaks
 * into the thrown error message" assertion is sharp. A bare-space
 * plaintext is trivially a substring of any English boilerplate
 * (`"failed to decrypt secret for key …"`) and would surface as a
 * false-positive failure without indicating any real leakage.
 */
const PLAINTEXT_MARKER = '__PLAINTEXT_LEAK_MARKER__';

const plaintextArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .map((s) => `${PLAINTEXT_MARKER}${s}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Spy {
  encryptCalls: Array<{ plaintext: string }>;
  decryptCalls: Array<{ ciphertext: Buffer }>;
  isAvailableCalls: number;
}

interface Harness {
  store: SecretsStore;
  storeMap: Map<string, Buffer>;
  storeWrites: Array<{ key: string; value: Buffer }>;
  spy: Spy;
}

function makeHarness(): Harness {
  const storeMap = new Map<string, Buffer>();
  const storeWrites: Array<{ key: string; value: Buffer }> = [];
  const store: SecretsStore = {
    getEncrypted(key) {
      return storeMap.get(key) ?? null;
    },
    setEncrypted(key, value) {
      storeWrites.push({ key, value });
      storeMap.set(key, value);
    },
    deleteByKey(key) {
      storeMap.delete(key);
    },
  };
  const spy: Spy = {
    encryptCalls: [],
    decryptCalls: [],
    isAvailableCalls: 0,
  };
  return { store, storeMap, storeWrites, spy };
}

function makeSafeStorage(opts: {
  spy: Spy;
  /** When defined, encryptString throws this on every call. */
  encryptThrows?: Error;
  /** When defined, decryptString throws this on every call. */
  decryptThrows?: Error;
  /** Default ciphertext returned by encryptString on success. */
  successCipher?: Buffer;
}): SafeStorageLike {
  return {
    isEncryptionAvailable(): boolean {
      opts.spy.isAvailableCalls += 1;
      return true;
    },
    encryptString(plaintext: string): Buffer {
      opts.spy.encryptCalls.push({ plaintext });
      if (opts.encryptThrows !== undefined) {
        throw opts.encryptThrows;
      }
      return opts.successCipher ?? Buffer.from('cipher', 'utf-8');
    },
    decryptString(ciphertext: Buffer): string {
      opts.spy.decryptCalls.push({ ciphertext });
      if (opts.decryptThrows !== undefined) {
        throw opts.decryptThrows;
      }
      return 'decrypted';
    },
  };
}

// ---------------------------------------------------------------------------
// Property 11 — encryption side
// ---------------------------------------------------------------------------

describe('secrets module — Property 11 (macos-platform-support)', () => {
  it('secrets.set propagates encryptString errors; never swallows, retries, or falls back to plaintext', () => {
    fc.assert(
      fc.property(errorArb, keyArb, plaintextArb, (cause, key, plaintext) => {
        const harness = makeHarness();
        const safeStorage = makeSafeStorage({
          spy: harness.spy,
          encryptThrows: cause,
        });
        const mod = createSecretsModule({
          store: harness.store,
          safeStorage,
        });

        let thrown: unknown = undefined;
        try {
          mod.set(key, plaintext);
        } catch (err) {
          thrown = err;
        }

        // (1) The call MUST throw. Swallowing is a Property 11
        //     violation regardless of what the underlying error was.
        expect(thrown).toBeInstanceOf(Error);
        const thrownErr = thrown as Error;

        // (2) The wrapper MUST name the cause's error class so the
        //     caller / IPC layer can distinguish encryption-layer
        //     failures from store-layer failures.
        expect(thrownErr.message).toContain('secrets.set');
        expect(thrownErr.message).toContain('encryption failed');
        expect(thrownErr.message).toContain(cause.name);

        // (3) The wrapper MUST NOT echo the cause's message. The
        //     guard in `secrets.ts` strips it deliberately to avoid
        //     leaking plaintext fragments that DPAPI / Keychain
        //     occasionally surface in their error strings. We use a
        //     distinctive marker (see `CAUSE_MARKER`) so the
        //     substring check is sharp — a leak of any portion of
        //     the cause message would carry the marker through.
        expect(thrownErr.message).not.toContain(CAUSE_MARKER);

        // (4) NEVER retry: encryptString fired exactly once for the
        //     single set() call.
        expect(harness.spy.encryptCalls.length).toBe(1);
        expect(harness.spy.encryptCalls[0]?.plaintext).toBe(plaintext);

        // (5) NEVER fall back to plaintext: the backing store must
        //     not have received any write at all. Even ciphertext
        //     would be wrong here (encrypt threw), but plaintext is
        //     the catastrophic case Requirement 10.4 explicitly
        //     forbids.
        expect(harness.storeWrites.length).toBe(0);
        expect(harness.storeMap.size).toBe(0);

        // (6) decryptString must not have been touched.
        expect(harness.spy.decryptCalls.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('secrets.get propagates decryptString errors as SecretsDecryptError; never swallows, retries, or returns plaintext', () => {
    fc.assert(
      fc.property(errorArb, keyArb, plaintextArb, (cause, key, plaintext) => {
        const harness = makeHarness();

        // Pre-seed a stored ciphertext for this key so `get` reaches
        // the decrypt branch. Use the plaintext bytes as a
        // deliberately wrong "ciphertext" — the decrypt stub throws
        // unconditionally, so the actual bytes never matter; storing
        // the plaintext here is also a useful tripwire: if the
        // module ever fell back to "return the raw stored bytes as
        // text" it would surface as a leaked plaintext in our
        // "thrown error message" check below.
        //
        // The module trims the key before calling `getEncrypted`
        // (see `assertNonEmptyKey` in `secrets.ts`), so we seed
        // under the trimmed form to ensure the lookup hits.
        const trimmedKey = key.trim();
        const cipherSeed = Buffer.from(plaintext, 'utf-8');
        harness.storeMap.set(trimmedKey, cipherSeed);

        const safeStorage = makeSafeStorage({
          spy: harness.spy,
          decryptThrows: cause,
        });
        const mod = createSecretsModule({
          store: harness.store,
          safeStorage,
        });

        let thrown: unknown = undefined;
        let returned: unknown = undefined;
        try {
          returned = mod.get(key);
        } catch (err) {
          thrown = err;
        }

        // (1) MUST throw — never return null / plaintext / anything.
        expect(returned).toBeUndefined();
        expect(thrown).toBeInstanceOf(SecretsDecryptError);

        const decryptErr = thrown as SecretsDecryptError;

        // (2) The thrown SecretsDecryptError carries the key name
        //     (per `secrets.ts` constructor) so callers can recover
        //     by deleting the offending entry.
        expect(decryptErr.name).toBe('SecretsDecryptError');
        expect(decryptErr.key).toBe(key.trim());
        expect(decryptErr.message).toContain(key.trim());

        // (3) The original cause's message MUST NOT be threaded
        //     through (design.md §Property 11: "the original cause
        //     is intentionally not propagated to avoid plaintext
        //     leakage"). The marker-bearing generator makes any
        //     leakage trivially detectable.
        expect(decryptErr.message).not.toContain(CAUSE_MARKER);

        // (4) The plaintext bytes we seeded as the stored ciphertext
        //     MUST NOT appear in the thrown error's message —
        //     defence-in-depth against the "read-the-bytes-back"
        //     fallback. The marker keeps the substring check sharp.
        expect(decryptErr.message).not.toContain(PLAINTEXT_MARKER);

        // (5) NEVER retry: decryptString fired exactly once.
        expect(harness.spy.decryptCalls.length).toBe(1);

        // (6) NEVER fall back to plaintext: the store was not
        //     mutated and the seeded ciphertext is still in place
        //     under the trimmed key.
        expect(harness.storeWrites.length).toBe(0);
        expect(harness.storeMap.get(trimmedKey)).toBe(cipherSeed);

        // (7) encryptString must not have been touched.
        expect(harness.spy.encryptCalls.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
