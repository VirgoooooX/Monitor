// Feature: network-quick-actions, Property 1
//
// Property tests for `rankQuickNodeCandidates` — the pure ranking
// helper that powers the Quick_Node_Card on the expanded window.
//
// References:
//   - design.md §`quickNode.ranking.ts` (algorithm)
//   - design.md §Property 1 (Quick Node ranking is correct, bounded,
//     and stable)
//   - requirements.md Requirement 3.2, 3.3
//
// Scope:
//   - Generate arbitrary candidate lists (mix of normal names + the
//     three pseudo nodes), an arbitrary `currentNode`, and per-node
//     histories of length 0..10 with mixed `ok` flags and arbitrary
//     `delayMs` values (including the `null`-on-failure shape).
//   - Assert the six invariants from design.md Property 1:
//       (1) output length ≤ 5
//       (2) `currentNode` is never present
//       (3) no pseudo node is present
//       (4) every output entry's last sample (in the input map) was
//           `ok === true`
//       (5) output is sorted by `avgLatencyMs` ascending; ties keep
//           the original input order (stable)
//       (6) `avgLatencyMs` equals the arithmetic mean of `delayMs`
//           over the OK samples in the last 10 entries of that
//           candidate's history.
//
// The implementation under test is pure (no I/O, no `Date.now`, no
// random), so we drive it directly without any test fakes. fast-check
// runs >= 100 iterations per the parent design's PBT contract.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  rankQuickNodeCandidates,
  type QuickNodeRankingInputs,
  type QuickNodeSample,
} from './quickNode.ranking';
import { EXCLUDED_NODE_NAMES } from './openclash.groups';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Pool of pseudo-node names. Mixed into the candidate list so the
 * "no pseudo nodes in output" invariant can be falsified if the
 * implementation regresses.
 */
const PSEUDO_NAMES = ['DIRECT', 'REJECT', 'GLOBAL'] as const;

/**
 * Pool of "real" candidate names. We use a small fixed pool (rather
 * than `fc.string`) so the same name shows up multiple times across
 * runs, exercising the `currentNode` exclusion path with realistic
 * frequency.
 */
const REAL_NAMES = [
  'hk-01',
  'hk-02',
  'jp-01',
  'jp-02',
  'sg-01',
  'us-01',
  'us-02',
  'tw-01',
  'tw-02',
  'kr-01',
] as const;

/**
 * Single sample arbitrary. We allow the `(ok=true, delayMs=null)` shape
 * — the type permits it and the implementation must tolerate it (such
 * a sample contributes to `okSamples` but not to the mean). Likewise
 * we allow `(ok=false, delayMs=number)` to defend against future
 * data shapes.
 */
const sampleArb: fc.Arbitrary<QuickNodeSample> = fc.record({
  ok: fc.boolean(),
  delayMs: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }),
});

/** History arbitrary: length 0..10 (the design's window cap). */
const historyArb: fc.Arbitrary<ReadonlyArray<QuickNodeSample>> = fc.array(
  sampleArb,
  { minLength: 0, maxLength: 10 },
);

/**
 * Candidate list arbitrary: a non-empty mix of real and pseudo names.
 * `fc.subarray` preserves the source order, which keeps the stable-
 * tie-break invariant testable end-to-end.
 */
const candidatesArb: fc.Arbitrary<string[]> = fc
  .subarray([...REAL_NAMES, ...PSEUDO_NAMES], { minLength: 0, maxLength: 13 })
  // Allow duplicates by occasionally repeating a chunk of the list.
  .chain((base) =>
    fc
      .array(fc.constantFrom(...base, ...REAL_NAMES), {
        minLength: 0,
        maxLength: 5,
      })
      .map((extras) => [...base, ...extras]),
  );

/**
 * Inputs arbitrary: a candidate list, a `currentNode` drawn from
 * either the candidate list itself, an unrelated string, or `null`,
 * and a per-node history map keyed by every name that might appear.
 */
const inputsArb: fc.Arbitrary<QuickNodeRankingInputs> = candidatesArb.chain(
  (candidates) => {
    // Build a key set covering every candidate plus a few foreign
    // names (so we exercise the "history exists for a non-candidate"
    // edge case, which the implementation must simply ignore).
    const allKeys = Array.from(
      new Set<string>([...candidates, ...REAL_NAMES, ...PSEUDO_NAMES]),
    );

    const currentNodeArb: fc.Arbitrary<string | null> = fc.oneof(
      fc.constant<string | null>(null),
      fc.constantFrom<string | null>(...allKeys),
      // A name that is not in the candidate list — should be a no-op.
      fc.constant<string | null>('not-a-real-node'),
    );

    const samplesEntriesArb = fc.tuple(
      ...allKeys.map((name) =>
        historyArb.map((history) => [name, history] as const),
      ),
    );

    return fc.record({
      candidates: fc.constant(candidates),
      currentNode: currentNodeArb,
      recentSamples: samplesEntriesArb.map(
        (entries) =>
          new Map<string, ReadonlyArray<QuickNodeSample>>(entries),
      ),
    });
  },
);

// ---------------------------------------------------------------------------
// Helpers used by the assertions
// ---------------------------------------------------------------------------

/**
 * Reference implementation of "first-pass index in the input
 * candidates array, excluding ineligible entries". Used to verify
 * the stable-tie-break invariant without re-implementing the full
 * ranking logic.
 */
function firstIndexOf(candidates: readonly string[], name: string): number {
  return candidates.indexOf(name);
}

/**
 * Re-derive `avgLatencyMs` from the input history per the design rules:
 *   - take the last 10 entries
 *   - sum delayMs over entries with `ok === true && delayMs !== null`
 *   - divide by the count of such entries
 * Returns `null` when no usable OK delay exists.
 */
function expectedAvgLatency(
  history: ReadonlyArray<QuickNodeSample> | undefined,
): number | null {
  if (history === undefined || history.length === 0) return null;
  const window =
    history.length <= 10 ? history : history.slice(history.length - 10);
  let sum = 0;
  let count = 0;
  for (const sample of window) {
    if (sample.ok && sample.delayMs !== null && Number.isFinite(sample.delayMs)) {
      sum += sample.delayMs;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rankQuickNodeCandidates — Property 1: ranking is correct, bounded, and stable', () => {
  it('honours all six invariants over arbitrary inputs', () => {
    fc.assert(
      fc.property(inputsArb, (inputs) => {
        const result = rankQuickNodeCandidates(inputs);

        // Invariant 1: length ≤ 5.
        expect(result.length).toBeLessThanOrEqual(5);

        // Invariants 2 and 3: currentNode and pseudo nodes never appear.
        for (const entry of result) {
          if (inputs.currentNode !== null) {
            expect(entry.nodeName).not.toBe(inputs.currentNode);
          }
          expect(EXCLUDED_NODE_NAMES.has(entry.nodeName)).toBe(false);
        }

        // Invariant 4: every output entry's last sample (in the input
        // map) was `ok === true`. Empty histories were excluded.
        for (const entry of result) {
          const history = inputs.recentSamples.get(entry.nodeName);
          expect(history).toBeDefined();
          expect(history!.length).toBeGreaterThan(0);
          const last = history![history!.length - 1]!;
          expect(last.ok).toBe(true);
          expect(entry.lastOk).toBe(true);
        }

        // Invariant 6: avgLatencyMs equals the arithmetic mean of
        // delayMs over OK samples in the last 10 entries.
        for (const entry of result) {
          const expected = expectedAvgLatency(
            inputs.recentSamples.get(entry.nodeName),
          );
          // The implementation excludes nodes whose computed mean is
          // null, so the output must always carry a numeric mean.
          expect(expected).not.toBeNull();
          expect(entry.avgLatencyMs).not.toBeNull();
          // Strict equality: the implementation does the same
          // floating-point operations in the same order, so the
          // result must match bit-for-bit.
          expect(entry.avgLatencyMs).toBe(expected);
        }

        // Invariant 5: ascending sort with stable tie-break by
        // input order. Walk adjacent pairs and verify either the
        // latency is strictly less, or it is equal and the names
        // appear in the input in non-decreasing order.
        //
        // Note: when two output entries share the same `nodeName`
        // (which can happen if the input `candidates` list contains
        // duplicates — the implementation preserves them, since
        // Property 1 does not require uniqueness), the stable
        // tie-break is observationally indistinguishable. We skip
        // those pairs.
        for (let i = 1; i < result.length; i += 1) {
          const prev = result[i - 1]!;
          const curr = result[i]!;
          // Both means are non-null per Invariant 6 above, but stay
          // defensive against a future relaxation of the rules.
          if (prev.avgLatencyMs === null || curr.avgLatencyMs === null) {
            // null sorts to the end; nothing more to check.
            continue;
          }
          expect(prev.avgLatencyMs).toBeLessThanOrEqual(curr.avgLatencyMs);
          if (
            prev.avgLatencyMs === curr.avgLatencyMs &&
            prev.nodeName !== curr.nodeName
          ) {
            const prevIdx = firstIndexOf(inputs.candidates, prev.nodeName);
            const currIdx = firstIndexOf(inputs.candidates, curr.nodeName);
            // Both names came from the candidate list — neither index
            // can be -1 because pseudo/current/no-history exclusions
            // never produce output entries.
            expect(prevIdx).toBeGreaterThanOrEqual(0);
            expect(currIdx).toBeGreaterThanOrEqual(0);
            expect(prevIdx).toBeLessThan(currIdx);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
