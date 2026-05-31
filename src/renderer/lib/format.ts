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

// ---------------------------------------------------------------------------
// Management / Config_Switch error code i18n
// ---------------------------------------------------------------------------
//
// Single source of truth for the localised label rendered against any
// management-client failure or lock-arbitration rejection. Every
// renderer surface (Quick_Actions_Panel banner, Config_Switch_Card
// inline error, last-switch hint, etc.) MUST funnel its display
// through `formatManagementError` so the user sees consistent
// phrasing and we keep Property 16 (network-quick-actions design.md)
// trivially total: every code in the union maps to a non-empty
// string at compile time.
//
// `ManagementErrorCode` is the closed enum mirrored in
// `src/main/types.ts` (see network-quick-actions design.md §IPC
// Surface). `'switch_in_progress'` is the orchestrator-side
// lock-arbitration code returned by the `desktop:switchOpenClashConfig`
// handler when the switch lock is held — see network-quick-actions
// design.md §Switch Lock and Requirements 9.1..9.3, 16.2.
//
// As of i18n-multilingual-support task 14.5 the helper takes a
// `Translator` produced by `useT()` (i.e. resolved against the
// active locale) so banners, inline errors, and last-switch hints
// flip live with the rest of the UI when the user changes language.

import type { Translator, TranslationKey } from '../../i18n';
import type { ManagementErrorCode } from './types';

/**
 * Closed-set Translation_Key map for every management /
 * config-switch error code surfaced to the renderer.
 *
 * The `Record<ManagementErrorCode | 'switch_in_progress', TranslationKey>`
 * type makes the map provably total: dropping a member or
 * mistyping a key is a TypeScript error at compile time, and the
 * referenced keys themselves are checked against the closed
 * `TranslationCatalog` interface.
 */
const MANAGEMENT_ERROR_KEYS: Record<
  ManagementErrorCode | 'switch_in_progress',
  TranslationKey
> = {
  auth_error: 'management.error.auth',
  http_error: 'management.error.http',
  network_error: 'management.error.network',
  verify_timeout: 'management.error.verifyTimeout',
  verify_mismatch: 'management.error.verifyMismatch',
  not_supported: 'management.error.notSupported',
  switch_in_progress: 'management.error.switchInProgress',
};

/**
 * Translate a `ManagementErrorCode` (or the lock-arbitration
 * `'switch_in_progress'` code) into its canonical user-facing label
 * for the active locale.
 *
 * Always returns a non-empty string — the input type is the closed
 * union the IPC layer guarantees, so there is no fallback branch
 * that produces an empty value. Renderer code that receives an
 * unknown string from the wire MUST narrow it to the union before
 * calling this helper; passing a stringly-typed value would be a
 * TypeScript error.
 *
 * @param t  The translator returned by `useT()` (or any other
 *           `Translator` bound to a Locale_Code). Required so the
 *           output flips live with the active locale.
 * @param code The closed management / lock-arbitration error code.
 */
export function formatManagementError(
  t: Translator,
  code: ManagementErrorCode | 'switch_in_progress',
): string {
  return t(MANAGEMENT_ERROR_KEYS[code]);
}
