// Tiny number / latency formatting helpers used by the compact widget.
//
// Kept dependency-free on purpose: the compact window's bundle budget
// is tight (PLAN.md §Development Setup explicitly avoids `recharts` and
// other heavy libraries) and these helpers are trivial enough that
// pulling in `numbro` / `d3-format` would be net-negative.

/**
 * Format a non-negative token count for the compact widget's bottom
 * line. We follow the conventional "1.2k / 12k / 1.2M" compact
 * notation rather than `Intl.NumberFormat({ notation: 'compact' })`
 * because the latter is locale-sensitive (zh-CN renders `1.2万`),
 * which collides with the design's English-style budget bar.
 *
 * Negative inputs collapse to "0"; non-finite inputs collapse to the
 * em-dash placeholder used elsewhere in the UI for "no data".
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '0';
  }
  if (n < 1000) {
    return String(Math.floor(n));
  }
  if (n < 10_000) {
    // 1.2k — one decimal for readability between 1k and 10k.
    return `${(n / 1000).toFixed(1)}k`;
  }
  if (n < 1_000_000) {
    return `${Math.floor(n / 1000)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Format an average latency for the right side of the status hero.
 * `null` collapses to an em-dash so the slot stays the same width
 * and the layout doesn't jump while data is loading.
 */
export function formatLatency(latencyMs: number | null): string {
  if (latencyMs === null || !Number.isFinite(latencyMs)) {
    return '—';
  }
  return `${Math.round(latencyMs)}ms`;
}
