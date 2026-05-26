// Pure ranking helper for the Quick_Node_Card on the expanded window.
//
// References:
//   - .kiro/specs/network-quick-actions/design.md §`quickNode.ranking.ts`
//   - .kiro/specs/network-quick-actions/requirements.md §Requirement 3
//     (Quick_Node_Card 主策略组)
//
// Why this lives in its own file:
//
// - The IPC handler that builds `getNetworkQuickActions` already does
//   the heavy lifting of reading from `node_samples`, joining with
//   `proxies`, and resolving the primary group. Ranking the resulting
//   candidate set is a pure transform: given a list of node names, a
//   per-node history of recent samples, and the currently selected
//   node, produce the top-5 button list. Keeping that logic free of
//   I/O lets the property test (task 5.2 — Property 1) drive it
//   without standing up SQLite or the Clash client.
// - This module never imports `Date.now`, `crypto.randomUUID`, or
//   `Math.random`. The ordering it emits depends only on its inputs,
//   which is what the "stable tie-break by input order" invariant in
//   the design demands.
//
// Determinism contract:
//
// `rankQuickNodeCandidates` is a total function over its inputs. The
// returned array length is bounded by 5 and the sort is stable: when
// two candidates have equal `avgLatencyMs` (or both happen to be
// `null`, which by the rules below they cannot be, but the
// implementation is defensive), the entry that appeared earlier in the
// input `candidates` array comes first. We rely on `Array.prototype
// .sort`'s stability guarantee, which is required by ES2019+ and held
// by every Node 18+ runtime this app ships against.

import { EXCLUDED_NODE_NAMES } from './openclash.groups';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of entries to return. Fixed at 5 (Open Question 1
 * resolution in design.md): "top **5** candidates". Not user-
 * configurable in v1.
 */
const MAX_CANDIDATES = 5;

/**
 * Latency window: only the most recent 10 samples per node are
 * considered when computing `avgLatencyMs`. Older samples are
 * discarded even if the caller passes a longer array (defensive — the
 * IPC handler should already trim, but this module is the single
 * source of truth for the rule).
 */
const LATENCY_WINDOW = 10;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QuickNodeSample {
  /** Whether the probe attempt succeeded. */
  readonly ok: boolean;
  /** Round-trip delay in milliseconds, or `null` when the probe failed. */
  readonly delayMs: number | null;
}

export interface QuickNodeRankingInputs {
  /** All non-pseudo nodes in the primary group, in Clash response order. */
  readonly candidates: readonly string[];
  /**
   * Most recent N=10 latency samples per candidate node, oldest-to-
   * newest. Nodes without an entry are treated as "no history".
   */
  readonly recentSamples: ReadonlyMap<string, ReadonlyArray<QuickNodeSample>>;
  /** The currently selected node in the primary group. Excluded from output. */
  readonly currentNode: string | null;
}

export interface QuickNodeCandidate {
  /** Node name as it appears in `/proxies`. */
  readonly nodeName: string;
  /**
   * Mean of OK delay samples over the last 10 entries. `null` when no
   * usable samples exist in the window — by the ranking rules below
   * such a node is excluded before reaching the output, so callers
   * can rely on a non-null value in practice. The field type stays
   * nullable to match the design contract.
   */
  readonly avgLatencyMs: number | null;
  /** Number of OK samples in the last 10 entries. */
  readonly okSamples: number;
  /** Whether the most recent sample (last in the array) was OK. */
  readonly lastOk: boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** True when `name` is one of Clash's built-in pseudo nodes. */
function isPseudoNode(name: string): boolean {
  return EXCLUDED_NODE_NAMES.has(name);
}

/**
 * Compute the per-candidate stats over the last `LATENCY_WINDOW`
 * entries. Returns `null` when the candidate has no history at all,
 * when the most recent sample is not `ok`, or when no usable OK delay
 * is available in the window.
 *
 * Returning `null` means "exclude from the output" — the caller does
 * not need to inspect the returned object further.
 */
function summarise(
  history: ReadonlyArray<QuickNodeSample> | undefined,
): QuickNodeCandidateSummary | null {
  if (history === undefined || history.length === 0) {
    return null;
  }

  // Take the last 10 entries. `slice` with a negative index handles
  // both the "history shorter than the window" and "history exactly
  // 10 long" cases without an extra branch.
  const window =
    history.length <= LATENCY_WINDOW
      ? history
      : history.slice(history.length - LATENCY_WINDOW);

  const lastSample = window[window.length - 1];
  if (lastSample === undefined || !lastSample.ok) {
    return null;
  }

  let okSamples = 0;
  let delaySum = 0;
  let delayCount = 0;
  for (const sample of window) {
    if (!sample.ok) {
      continue;
    }
    okSamples += 1;
    if (sample.delayMs !== null && Number.isFinite(sample.delayMs)) {
      delaySum += sample.delayMs;
      delayCount += 1;
    }
  }

  // Rule 2 guarantees `lastSample.ok` here, so `okSamples >= 1`. If
  // every OK sample has a null `delayMs` (unusual but allowed by the
  // type), fall back to `null` so the candidate is still excluded.
  const avgLatencyMs = delayCount > 0 ? delaySum / delayCount : null;
  if (avgLatencyMs === null) {
    return null;
  }

  return {
    avgLatencyMs,
    okSamples,
    lastOk: true,
  };
}

interface QuickNodeCandidateSummary {
  readonly avgLatencyMs: number;
  readonly okSamples: number;
  readonly lastOk: true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rank the primary group's candidate nodes for the Quick_Node_Card.
 *
 * Algorithm (matches design.md §`quickNode.ranking.ts`):
 *
 *   1. Exclude `currentNode` and any pseudo node (`DIRECT`, `REJECT`,
 *      `GLOBAL`).
 *   2. Exclude any candidate whose most recent sample (last entry in
 *      the per-node array) is not `ok`. Empty histories are excluded
 *      too — we cannot guess latency.
 *   3. For each remaining candidate compute
 *      `avgLatencyMs = mean(s.delayMs for s in last 10 where s.ok)`.
 *   4. Sort by `avgLatencyMs` ascending. Ties keep the input order
 *      (stable sort over the input `candidates` array).
 *   5. Return at most {@link MAX_CANDIDATES} entries.
 *
 * The function never mutates its inputs and never reads from any
 * external source — no `Date.now`, no `Math.random`, no I/O.
 */
export function rankQuickNodeCandidates(
  inputs: QuickNodeRankingInputs,
): QuickNodeCandidate[] {
  const { candidates, recentSamples, currentNode } = inputs;

  // First pass: filter + summarise while preserving input order. We
  // tag each surviving entry with its original index so the stable
  // tie-break in pass 2 does not depend on `Array.prototype.sort`'s
  // engine-specific behaviour for equal keys (Node guarantees
  // stability since v12, but tagging makes the contract explicit).
  const survivors: Array<{
    readonly index: number;
    readonly candidate: QuickNodeCandidate;
  }> = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const name = candidates[index];
    if (name === undefined) {
      // `noUncheckedIndexedAccess` widens `string[]` lookups; this
      // branch is unreachable in practice because we iterate up to
      // `candidates.length`.
      continue;
    }
    if (name === currentNode) {
      continue;
    }
    if (isPseudoNode(name)) {
      continue;
    }

    const summary = summarise(recentSamples.get(name));
    if (summary === null) {
      continue;
    }

    survivors.push({
      index,
      candidate: {
        nodeName: name,
        avgLatencyMs: summary.avgLatencyMs,
        okSamples: summary.okSamples,
        lastOk: summary.lastOk,
      },
    });
  }

  // Stable sort by avgLatencyMs ascending, falling back to the
  // original input index. We never see `null` here because rule 2 +
  // the `summarise` null-return path already excluded those nodes,
  // but the comparator stays defensive so a future relaxation of the
  // rules cannot accidentally promote a `null`-latency entry to the
  // top of the list.
  survivors.sort((a, b) => {
    const aLatency = a.candidate.avgLatencyMs;
    const bLatency = b.candidate.avgLatencyMs;
    if (aLatency === null && bLatency === null) {
      return a.index - b.index;
    }
    if (aLatency === null) {
      return 1;
    }
    if (bLatency === null) {
      return -1;
    }
    if (aLatency !== bLatency) {
      return aLatency - bLatency;
    }
    return a.index - b.index;
  });

  // Cap at MAX_CANDIDATES and unwrap the tagged entries.
  const capped =
    survivors.length <= MAX_CANDIDATES
      ? survivors
      : survivors.slice(0, MAX_CANDIDATES);
  return capped.map((entry) => entry.candidate);
}
