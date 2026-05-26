// Feature: AI accounts unification + cpa-quota-import Property 6
//
// `deriveKnownProviders(providerAuthRows)` is the runtime replacement
// for the previously hardcoded `KNOWN_PROVIDERS` constant in
// `usage.service.ts`. After the AI Accounts unification the
// derivation has a single input: the `provider_auth` rows whose
// `enabled === true`. Disabled rows and the legacy
// `settings.collectors` map no longer participate.
//
// The returned array MUST be sorted ascending and deduplicated, and
// MUST be a subset of the enabled providers in the input.
//
// References:
//   - planning doc "统一 AI 账号来源、凭据输入与启用开关"
//   - src/main/services/usage.service.ts (`deriveKnownProviders`)

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { deriveKnownProviders } from './usage.service';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// Provider keys are short non-empty strings drawn from a small alphabet
// so collisions across rows happen frequently enough that the
// deduplication path is exercised. ASCII-only keys keep the sort
// comparison deterministic across platforms.
const PROVIDER_KEY_ARB: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => s.length > 0);

// `provider_auth`-shaped row — `deriveKnownProviders` only reads
// `provider` and `enabled`. Length is capped to keep generation cheap.
const PROVIDER_AUTH_ROWS_ARB: fc.Arbitrary<
  ReadonlyArray<{ provider: string; enabled: boolean }>
> = fc.array(
  fc.record({
    provider: PROVIDER_KEY_ARB,
    enabled: fc.boolean(),
  }),
  { maxLength: 12 },
);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('usage.service — deriveKnownProviders (AI accounts unification)', () => {
  it(
    'is a sorted, deduplicated set of providers whose enabled rows are present',
    () => {
      fc.assert(
        fc.property(PROVIDER_AUTH_ROWS_ARB, (rows) => {
          const result = deriveKnownProviders(rows);

          // (a) Sorted ascending (strictly-increasing — uniqueness
          //     is folded into the same check).
          for (let i = 1; i < result.length; i += 1) {
            expect(result[i - 1]! < result[i]!).toBe(true);
          }

          // (b) Deduplicated.
          expect(new Set(result).size).toBe(result.length);

          // (c) Every enabled row's provider appears.
          for (const row of rows) {
            if (row.enabled) {
              expect(result).toContain(row.provider);
            }
          }

          // (d) Every result entry is the `provider` of at least one
          //     enabled row — no spurious values leak through.
          const enabledProviders = new Set(
            rows.filter((r) => r.enabled).map((r) => r.provider),
          );
          for (const value of result) {
            expect(enabledProviders.has(value)).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it('returns an empty array when every row is disabled', () => {
    expect(
      deriveKnownProviders([
        { provider: 'codex', enabled: false },
        { provider: 'gemini-api', enabled: false },
      ]),
    ).toEqual([]);
  });

  it('returns an empty array when no rows are passed', () => {
    expect(deriveKnownProviders([])).toEqual([]);
  });
});
