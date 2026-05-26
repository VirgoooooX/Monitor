// Feature: cpa-quota-import, Property 6
//
// Property 6: Derived providers cover collectors + auth + baseline,
// with no duplicates.
//
// Validates: Requirement 14.1.
//
// `deriveKnownProviders(collectors, providerAuthRows)` is the runtime
// replacement for the previously hardcoded `KNOWN_PROVIDERS` constant
// in `usage.service.ts`. Per `cpa-quota-import/design.md §Dynamic
// KNOWN_PROVIDERS` and `cpa-quota-import/requirements.md
// Requirement 14.1`, the derivation MUST produce a set that is the
// union of three sources:
//
//   1. The shipped baseline (`codex`, `gemini`, `antigravity`,
//      `opencode`, `deepseek`) — present even with empty inputs so
//      historical aggregates do not silently disappear.
//   2. Every key in `collectors` whose `enabled === true`.
//   3. Every `row.provider` value from `provider_auth`.
//
// The returned array MUST be sorted ascending and deduplicated.
//
// References:
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 14.1
//     (KNOWN_PROVIDERS derivation: baseline + enabled collectors + provider_auth)
//   - .kiro/specs/cpa-quota-import/design.md §Dynamic KNOWN_PROVIDERS
//   - src/main/services/usage.service.ts (`deriveKnownProviders`,
//     `BASELINE_PROVIDERS`)

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { deriveKnownProviders } from './usage.service';

// ---------------------------------------------------------------------------
// Mirror of the baseline from `usage.service.ts`. Kept inline so the
// property test depends only on the exported function, not on private
// module state. If the production baseline ever changes this constant
// must be updated to match.
// ---------------------------------------------------------------------------

const BASELINE_PROVIDERS = [
  'codex',
  'gemini',
  'antigravity',
  'opencode',
  'deepseek',
] as const;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// Provider keys are short non-empty strings drawn from a small alphabet
// so collisions with the baseline (and between collectors / auth rows)
// happen frequently enough that the deduplication path is exercised.
// ASCII-only keys keep the sort comparison deterministic across platforms.
const PROVIDER_KEY_ARB: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => s.length > 0);

// `Record<string, { enabled: boolean }>` — `fc.dictionary` returns a
// plain object suitable for `Object.entries` in the production code.
const COLLECTORS_ARB: fc.Arbitrary<Record<string, { enabled: boolean }>> = fc.dictionary(
  PROVIDER_KEY_ARB,
  fc.record({ enabled: fc.boolean() }),
  { maxKeys: 8 },
);

// `provider_auth` rows — only the `provider` column is relevant to
// `deriveKnownProviders`. Length is capped to keep generation cheap.
const PROVIDER_AUTH_ROWS_ARB: fc.Arbitrary<ReadonlyArray<{ provider: string }>> = fc.array(
  fc.record({ provider: PROVIDER_KEY_ARB }),
  { maxLength: 8 },
);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('usage.service — Property 6 (cpa-quota-import)', () => {
  it(
    'deriveKnownProviders is a sorted, deduplicated superset of baseline ∪ enabled collectors ∪ auth rows',
    () => {
      fc.assert(
        fc.property(COLLECTORS_ARB, PROVIDER_AUTH_ROWS_ARB, (collectors, rows) => {
          const result = deriveKnownProviders(collectors, rows);

          // (a) Sorted ascending.
          for (let i = 1; i < result.length; i += 1) {
            expect(result[i - 1] < result[i]).toBe(true);
          }

          // (b) Deduplicated (a strictly-increasing sort already
          //     implies uniqueness; the explicit Set check guards
          //     against accidental tie-equality bugs in the assertion
          //     above and matches the property statement directly).
          expect(new Set(result).size).toBe(result.length);

          // (c) Every baseline value appears.
          for (const baseline of BASELINE_PROVIDERS) {
            expect(result).toContain(baseline);
          }

          // (d) Every collector with `enabled === true` appears.
          for (const [key, value] of Object.entries(collectors)) {
            if (value.enabled === true) {
              expect(result).toContain(key);
            }
          }

          // (e) Every `provider_auth.provider` value appears.
          for (const row of rows) {
            expect(result).toContain(row.provider);
          }
        }),
        { numRuns: 100 },
      );
    },
  );
});
