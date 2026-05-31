// Public surface of the shared i18n runtime for the
// i18n-multilingual-support feature.
//
// This module is the canonical owner of the `Locale_Code` union and
// the public façade composed of `resolve`, `applyParams`, and the
// main-side `getActiveLocale` singleton. Both `src/main/**` and
// `src/renderer/**` import from this module at runtime — it is the
// only documented exception to the renderer ↔ main isolation rule
// (see design.md §Architecture and the JSDoc in tsconfig.main.json /
// tsconfig.renderer.json).
//
// Two consumers, two ergonomic surfaces:
//
//   1. `createTranslator(locale)` — pure function returning a
//      Translator bound to a fixed `Locale_Code`. Used by the renderer
//      from `<I18nProvider>` so React state alone determines what the
//      UI renders, and a stale closure can never resolve against a
//      newer Active_Locale (Requirements 7.1, 7.2, 10).
//
//   2. `t(key, params)` — main-side ambient that reads
//      `getActiveLocale()` on every call. Used by `tray.ts` and
//      `dialog.showOpenDialog` filters where there is no React tree
//      to thread a translator through (Requirement 5).
//
// Neither function throws (Requirement 9.3). `resolve()` already
// returns a string under every input shape — empty/non-string keys
// surface the `<empty-i18n-key>` sentinel (Requirement 9.7), missing
// keys fall back to the configured fallback locale and finally to
// the literal key (Requirements 4.8, 5.5, 6.9, 9.1, 9.2).
// `applyParams()` wraps the substitution in try/catch so even
// rogue `symbol` values cannot escape the public API as throws
// (Requirement 9.6).
//
// The fallback locale differs by surface and is wired here:
//
//   - `createTranslator(locale)` uses `resolve()`'s default fallback
//     (`'zh-CN'`), matching the renderer-side default in design.md:
//     a missing en-US key surfaces the original zh-CN copy.
//   - `t(...)` (main-side ambient) explicitly passes `'en-US'` as the
//     fallback so missing zh-CN keys surface ASCII rather than CJK.
//     This matches design.md's main-side fallback chain
//     `active → 'en-US' → literal key` and is the contract referenced
//     by Requirement 5.5.

import type { TranslationCatalog, TranslationKey } from './catalogs/types';
import { applyParams } from './format';
import { resolve } from './resolve';
import { getActiveLocale } from './active-locale';

/**
 * The closed set of supported BCP-47 language tags for v1.
 *
 * `zh-CN` is the source language and Default_Locale; `en-US` is the
 * curated translation. Adding a third locale is a deliberate scope
 * change pinned by Requirement 3.1 (no dynamic registration), not a
 * runtime extension point.
 */
export type Locale_Code = 'zh-CN' | 'en-US';

/**
 * Iteration-friendly `Locale_Code` enumeration. Marked
 * `readonly Locale_Code[]` so accidental mutation is a tsc error,
 * and exported as a tuple-typed value so call sites can do
 * `SUPPORTED_LOCALE_CODES.includes(candidate as Locale_Code)`
 * without losing literal-type narrowing.
 */
export const SUPPORTED_LOCALE_CODES: readonly Locale_Code[] = ['zh-CN', 'en-US'];

/**
 * The Default_Locale. Used as the renderer-side initial state before
 * `desktop.getSettings()` resolves (Requirement 10.1) and as the
 * fallback target inside `resolve()` when the active locale lacks the
 * requested key.
 */
export const DEFAULT_LOCALE: Locale_Code = 'zh-CN';

// Re-export the catalog shape and key alias from `./catalogs/types` so
// the public surface is a single import site for downstream code:
// `import { t, type TranslationKey } from '../i18n'`.
export type { TranslationCatalog, TranslationKey } from './catalogs/types';

/**
 * Function shape of a Translator bound to a specific Locale_Code.
 *
 * The `params` argument is typed loosely as
 * `Record<string, unknown>` at the public surface so call sites do
 * not need to manually narrow values to the placeholder-substitution
 * input set; `applyParams` performs the runtime coercion via
 * `String(value)` and is wrapped in try/catch so symbol values cannot
 * escape as throws (Requirement 9.6).
 */
export interface Translator {
  (key: TranslationKey, params?: Record<string, unknown>): string;
}

// Internal alias for the narrower input shape that `applyParams`
// declares. Kept colocated with the cast so the public Translator
// type stays loose without forcing every call site to narrow.
type ApplyParamsInput = Record<string, string | number | boolean | null | undefined>;

/**
 * Build a translator bound to a fixed Locale_Code.
 *
 * Pure: the returned function closes over `locale` and the imported
 * pure helpers `resolve` and `applyParams`. No mutable global state
 * is consulted, so two translators built for the same locale are
 * observationally equivalent.
 *
 * Used by the renderer's `<I18nProvider>` to publish a fresh
 * Translator on every Active_Locale change (Requirement 7.1, 10).
 * The fallback locale defaults to `'zh-CN'` per `resolve()`'s
 * documented default; this matches the renderer-side fallback chain
 * `active → 'zh-CN' → literal key`.
 */
export function createTranslator(locale: Locale_Code): Translator {
  return (key, params) =>
    applyParams(resolve(key, locale), params as ApplyParamsInput | undefined);
}

/**
 * Main-side ambient Translation_Function.
 *
 * Reads `getActiveLocale()` on every call so a `setActiveLocale(...)`
 * write from `applyAndPersistSettings` is observed by the very next
 * `t()` call (Requirements 5.3, 7.5). The fallback locale is fixed at
 * `'en-US'` so missing zh-CN keys surface ASCII labels rather than
 * the literal Translation_Key, which matches design.md's main-side
 * fallback chain `active → 'en-US' → literal key`
 * (Requirement 5.5).
 *
 * MUST NEVER throw (Requirement 9.3): every branch of `resolve` and
 * `applyParams` is total.
 */
export function t(key: TranslationKey, params?: Record<string, unknown>): string {
  return applyParams(
    resolve(key, getActiveLocale(), 'en-US'),
    params as ApplyParamsInput | undefined,
  );
}
