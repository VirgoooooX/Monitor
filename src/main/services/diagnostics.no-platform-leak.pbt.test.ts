// Feature: macos-platform-support, Property 10: diagnostics report contains no secret value as a substring on win32 and darwin.
//
// Validates: Requirements 11.4, 13.6
//
// Property: For any platform ∈ {win32, darwin} and any non-empty
// secret plaintext (length 1..200), when the secret is written via
// `secrets.set` and the diagnostics report is JSON-stringified, the
// plaintext does NOT appear as a substring of the stringified report.
//
// Strategy:
//
//   * Use the production `createSecretsModule` factory wired to a
//     deterministic XOR `safeStorage` stub and an in-memory
//     `SecretsStore`. This guarantees the on-disk row is ciphertext
//     and lets us assert the redaction sieve never surfaces the
//     plaintext value on either platform.
//   * Mock `process.platform` and `process.arch` for the duration of
//     each iteration via configurable property descriptors; restore
//     in `finally`. No global mutation leaks between iterations.
//   * Use the same diagnostics service factory wiring as production
//     (`createDiagnosticsService`) with hand-built repository stubs
//     so the test exercises the real value-based redaction sieve.
//   * The `getSecretValues` callback supplied to the diagnostics
//     service returns the current secret plaintext, so the sieve has
//     a realistic input to scan against.
//   * Run >=100 fast-check cases per the spec contract.
//
// Pragmatic filtering
// -------------------
//
// The redaction sieve only replaces leaf string VALUES that exactly
// equal a known secret — it cannot redact substrings inside object
// KEYS. As a result, a single-character or natural-content secret
// (e.g. "S", "l", "ok", "null") is naturally a substring of fixed
// JSON keys in the diagnostics report (`recentConfigSwitches`,
// `managementInterface`, `providerAuthAccounts`, `lastCapability`,
// `collectors`, `schemaVersion`, `redactedControllerUrl`,
// `generatedAt`) and of closed-set platform/arch values
// (`win32`, `darwin`, `x64`, `arm64`, `ia32`, etc.). Such matches
// are a test-generator-degeneracy issue, not a redaction bug.
//
// To keep the property meaningful we `fc.pre()`-skip iterations whose
// generated secret is a substring of (or contains) one of these
// natural-content tokens. The skipped cases are NOT property
// failures — they are degenerate inputs whose match-as-substring
// would falsely flag the production code's correct behavior. This
// filter is a property-preserving refinement of the input space; the
// underlying invariant (no secret VALUE leaks past the redaction
// sieve) remains exactly the one Property 10 asserts. Mirrors the
// blocklist pattern used in `no-secret-leakage.pbt.test.ts`.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createDiagnosticsService } from './diagnostics.service';
import {
  createSecretsModule,
  type SafeStorageLike,
  type SecretsStore,
} from '../security/secrets';
import type {
  CollectorHealthRepository,
  CollectorHealthRow,
  SettingsRepository,
} from '../store/repositories';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECRET_KEY = 'macos-platform-support.test.secret';
const ENCRYPTION_MASK = 0xaa;

/**
 * Strings that naturally appear in the diagnostics report's JSON
 * keys or closed-set platform/arch values. Any generated secret
 * that is a substring of (or contains) one of these tokens is
 * skipped via `fc.pre()` — see the "Pragmatic filtering" note at
 * the file header for the rationale.
 *
 * Mirrors the `NATURAL_CONTENT_BLOCKLIST` pattern in
 * `no-secret-leakage.pbt.test.ts`. The list is deliberately
 * over-inclusive — it is cheaper to skip a slightly-too-restrictive
 * input than to chase down a false-positive shrink. In addition to
 * this static list, `shouldSkipSecret` compares candidates against a
 * baseline diagnostics JSON string for the target platform so small
 * substrings in fixed report keys (for example `is`) are filtered
 * without continually extending this list by hand.
 */
const NATURAL_CONTENT_BLOCKLIST = [
  // Closed-set platform / arch values (Requirement 11.1).
  'platform',
  'arch',
  'win32',
  'darwin',
  'linux',
  'x64',
  'arm64',
  'ia32',
  // Top-level diagnostics report keys.
  'generatedAt',
  'collectors',
  'lastCapability',
  'redactedControllerUrl',
  'recentConfigSwitches',
  'managementInterface',
  'providerAuthAccounts',
  'schemaVersion',
  // Generic literals used in JSON values / null markers / closed-set
  // capability codes that may appear verbatim in the report.
  '<redacted>',
  'null',
  'true',
  'false',
];

// ---------------------------------------------------------------------------
// XOR-based safeStorage stub — guarantees ciphertext != plaintext for
// any non-empty plaintext (the in-test analogue of DPAPI / Keychain).
// ---------------------------------------------------------------------------

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

function makeStore(): SecretsStore {
  const map = new Map<string, Buffer>();
  return {
    getEncrypted(key) {
      return map.get(key) ?? null;
    },
    setEncrypted(key, value) {
      map.set(key, value);
    },
    deleteByKey(key) {
      map.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Repository stubs — empty inputs keep the report surface minimal so
// the only string a leak could land in is the redaction sieve's own
// output.
// ---------------------------------------------------------------------------

function buildSettingsStub(): SettingsRepository {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      store.set(key, value);
    },
    remove(key: string): void {
      store.delete(key);
    },
    keys(): string[] {
      return [...store.keys()].sort();
    },
    entries(): Array<{ key: string; value: unknown }> {
      return [...store.entries()].map(([key, value]) => ({ key, value }));
    },
  };
}

function buildCollectorHealthStub(): CollectorHealthRepository {
  return {
    upsert: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    get: () => undefined,
    list: (): CollectorHealthRow[] => [],
  };
}

// ---------------------------------------------------------------------------
// Platform / arch swap helper (configurable descriptors, restored in
// `finally`). This does not mutate any module's globals — only the
// `process.platform` / `process.arch` getters for the duration of one
// `service.export()` call.
// ---------------------------------------------------------------------------

function withFakedPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    get() {
      return platform;
    },
  });
  try {
    return fn();
  } finally {
    if (platformDescriptor !== undefined) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  }
}

// ---------------------------------------------------------------------------
// Natural-content filter
// ---------------------------------------------------------------------------

/**
 * Decide whether to skip a generated secret because it would
 * naturally appear as a substring of expected non-secret content.
 * See the "Pragmatic filtering" note at the file header for the
 * rationale.
 */
function buildNaturalDiagnosticsJson(platform: NodeJS.Platform): string {
  const service = createDiagnosticsService({
    settings: buildSettingsStub(),
    collectorHealth: buildCollectorHealthStub(),
    getSecretValues: () => [],
  });
  const report = withFakedPlatform(platform, () => service.export());
  return JSON.stringify(report);
}

function shouldSkipSecret(platform: NodeJS.Platform, value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  // Single-character secrets collide with JSON delimiters, the
  // schemaVersion digit, and individual letters appearing in any of
  // the report's fixed JSON keys. Skip them.
  if (value.length < 2) {
    return true;
  }
  // Pure-digit secrets collide with `generatedAt` (a millisecond
  // timestamp) and the `schemaVersion: 1` literal.
  if (/^[0-9]+$/.test(value)) {
    return true;
  }
  for (const blocked of NATURAL_CONTENT_BLOCKLIST) {
    if (blocked.includes(value) || value.includes(blocked)) {
      return true;
    }
  }
  if (buildNaturalDiagnosticsJson(platform).includes(value)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('diagnostics — Property 10: no platform-induced secret leak (win32 / darwin)', () => {
  it('skips candidates already present in natural diagnostics content', () => {
    expect(shouldSkipSecret('win32', 'is')).toBe(true);
  });

  it('JSON.stringify(report) never contains a stored secret plaintext as a substring', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<NodeJS.Platform>('win32', 'darwin'),
        fc.string({ minLength: 1, maxLength: 200 }),
        (platform, secretValue) => {
          // Skip degenerate inputs that would trigger natural-content
          // false positives (see file header).
          fc.pre(!shouldSkipSecret(platform, secretValue));

          // Build a fresh secrets module + diagnostics service per
          // iteration so the in-memory state is isolated.
          const secretsModule = createSecretsModule({
            store: makeStore(),
            safeStorage: makeXorSafeStorage(),
          });

          // Write the secret via the production `secrets.set` path
          // so the ciphertext is actually persisted.
          secretsModule.set(SECRET_KEY, secretValue);

          // Sanity: the secret round-trips so the value-based
          // redaction sieve has the correct plaintext to scan against.
          const roundTripped = secretsModule.get(SECRET_KEY);
          expect(roundTripped).toBe(secretValue);

          const service = createDiagnosticsService({
            settings: buildSettingsStub(),
            collectorHealth: buildCollectorHealthStub(),
            getSecretValues: () => [secretValue],
          });

          // Export under the faked platform. `process.arch` does not
          // affect redaction so we leave it on its real value.
          const report = withFakedPlatform(platform, () => service.export());
          const json = JSON.stringify(report);

          // Confirm the `platform` field landed on the output (smoke
          // check that the swap took effect — without it the
          // following non-leak assertion would still pass on a
          // codebase that simply omitted the field, hiding a
          // regression).
          expect(report.platform).toBe(platform);

          // The actual property: the plaintext secret is NOT a
          // substring of the JSON-stringified report.
          expect(json.includes(secretValue)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
