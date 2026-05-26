// Pure helpers for selecting the "primary" Clash policy group from a
// `/proxies` response.
//
// References:
//   - design.md §`openclash.identifyPrimaryGroup` formal spec
//   - PLAN.md §策略组识别
//
// Why this lives in its own file:
//
// - The OpenClash HTTP client (`openclash.service.ts`) is an I/O surface
//   that pulls in `fetch`, zod, and the secrets singleton. Group
//   identification is a pure function over a parsed response and the
//   user's preference list. Keeping it in a dedicated module means the
//   property tests (task 3.4 — Property 13) can import it without
//   dragging the network client into the test sandbox, and callers that
//   already hold a parsed `ProxiesResponse` in memory don't need to
//   instantiate a client to ask "which group is primary?".
// - The function is re-exported from `openclash.service.ts` so callers
//   that already depend on the client don't need an extra import path.
//
// Determinism contract:
//
// `identifyPrimaryGroup` is fully deterministic for a given
// `(proxies, primaryGroups)` pair. The first preference-list match wins;
// otherwise the fallback iterates `proxies.proxies` in the response's
// **insertion order**. We rely on the ES2015+ guarantee that `Object.keys`
// (and `for…in` over own string keys) returns string keys in the order
// they were inserted, which is the order produced by `JSON.parse`. This
// matters for Property 13 (group identification determinism): without a
// stable iteration order the fallback's "first match" is not well-
// defined.

import type { ProxiesResponse, ProxyEntry } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Names that Clash always exposes as built-in pseudo-nodes. They never
 * count as "real" options for the fallback heuristic.
 *
 * The match is case-sensitive: real Clash builds emit these names exactly
 * as `DIRECT`, `REJECT`, and `GLOBAL`, and a user-defined node sharing a
 * lower-cased variant should be treated as a real option.
 */
export const EXCLUDED_NODE_NAMES: ReadonlySet<string> = new Set([
  'DIRECT',
  'REJECT',
  'GLOBAL',
]);

/** Clash type tag for a manually-selectable policy group. */
const SELECTOR_TYPE = 'Selector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count how many entries in `entry.all` are "real" node options — i.e.
 * not the built-in DIRECT/REJECT/GLOBAL pseudo-nodes.
 *
 * `entry.all` is typed as `string[] | undefined` (selectors always emit
 * the array, but the field is optional on `ProxyEntry` because non-group
 * proxy types omit it). A missing array yields `0`.
 *
 * This helper is exported so the property test for Property 13 can build
 * generators that target the boundary (exactly 3 vs. 4 real options) and
 * the cleanup tests can assert behaviour without re-deriving the rule.
 */
export function countRealOptions(entry: ProxyEntry): number {
  const all = entry.all;
  if (all === undefined) {
    return 0;
  }
  let count = 0;
  for (const name of all) {
    if (!EXCLUDED_NODE_NAMES.has(name)) {
      count += 1;
    }
  }
  return count;
}

/** True when a name is one of Clash's built-in pseudo nodes/groups. */
export function isPseudoNodeName(name: string | null | undefined): boolean {
  return typeof name === 'string' && EXCLUDED_NODE_NAMES.has(name);
}

/** Current selected value for a Selector group, normalised to null. */
export function selectedNodeName(entry: ProxyEntry): string | null {
  const value = entry.now ?? entry.current ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export interface ResolvedSelectedNode {
  /** Selector group that directly selected the resolved leaf node. */
  groupName: string;
  /** Final non-pseudo leaf proxy name. */
  nodeName: string;
}

/**
 * Follow nested Selector selections until the final real proxy node is
 * reached. Example: `GLOBAL -> SS -> CN 台湾A01` resolves to
 * `{ groupName: 'SS', nodeName: 'CN 台湾A01' }`.
 */
export function resolveSelectedNode(
  proxies: ProxiesResponse,
  startGroupName: string | null,
): ResolvedSelectedNode | null {
  if (startGroupName === null) {
    return null;
  }

  const map = proxies.proxies;
  let groupName = startGroupName;
  const seen = new Set<string>();

  while (!seen.has(groupName)) {
    seen.add(groupName);
    const entry = map[groupName];
    if (entry === undefined || !isSelector(entry)) {
      return null;
    }

    const selected = selectedNodeName(entry);
    if (selected === null || isPseudoNodeName(selected)) {
      return null;
    }

    const selectedEntry = map[selected];
    if (selectedEntry !== undefined && isSelector(selectedEntry)) {
      groupName = selected;
      continue;
    }

    return { groupName, nodeName: selected };
  }

  return null;
}

/** True when `entry` is a Selector group (the only switchable kind). */
function isSelector(entry: ProxyEntry): boolean {
  return entry.type === SELECTOR_TYPE;
}

function isRealSelectorGroup(name: string, entry: ProxyEntry): boolean {
  return (
    !isPseudoNodeName(name) &&
    isSelector(entry) &&
    countRealOptions(entry) > 0
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Identify the "primary" policy group for a Clash controller response.
 *
 * Algorithm (matching design.md §`identifyPrimaryGroup` formal spec):
 *
 *   1. **Preference pass.** Walk `primaryGroups` in order. For each
 *      candidate name, return it if and only if it is not a pseudo
 *      group name, exists, is a Selector, and has at least one real
 *      node option.
 *
 *   2. **Fallback pass.** Walk the keys of `proxies.proxies` in the
 *      response's insertion order and choose the real Selector with
 *      the highest real-node count, provided its current value is not
 *      a pseudo node. Ties keep response order.
 *
 *   3. Otherwise return `null`.
 *
 * The function never mutates its inputs.
 *
 * @param proxies        Parsed `/proxies` body (already validated by zod).
 * @param primaryGroups  User-ordered preference list. Entries are matched
 *                       against `proxies.proxies` keys verbatim — no
 *                       trimming or case folding. The caller (settings
 *                       layer) is responsible for normalising user input
 *                       before persisting it.
 * @returns the chosen group name, or `null` when no Selector qualifies.
 */
export function identifyPrimaryGroup(
  proxies: ProxiesResponse,
  primaryGroups: readonly string[],
): string | null {
  const map = proxies.proxies;

  // Pass 1: explicit preference list. We intentionally do NOT short-
  // circuit on a non-Selector match — design.md says "first … that
  // exists in p and is a Selector", so a preferred name registered as a
  // URLTest or a leaf proxy must be skipped over to the next preference.
  for (const name of primaryGroups) {
    const entry = map[name];
    if (entry !== undefined && isRealSelectorGroup(name, entry)) {
      return name;
    }
  }

  // Pass 2: fallback heuristic. Keep the first highest-scoring group
  // so ties preserve the Clash response order.
  let bestName: string | null = null;
  let bestRealCount = 0;
  for (const name of Object.keys(map)) {
    const entry = map[name];
    if (entry === undefined) {
      // Defensive: `noUncheckedIndexedAccess` widens the lookup to
      // `ProxyEntry | undefined` even though we just got the key from
      // the same map. This branch is unreachable in practice.
      continue;
    }
    if (!isRealSelectorGroup(name, entry)) {
      continue;
    }
    const current = selectedNodeName(entry);
    if (isPseudoNodeName(current)) {
      continue;
    }
    const realCount = countRealOptions(entry);
    if (realCount > bestRealCount) {
      bestName = name;
      bestRealCount = realCount;
    }
  }

  return bestName;
}
