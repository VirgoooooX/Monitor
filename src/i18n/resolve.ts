// Pure key→string resolver for the i18n-multilingual-support feature.
//
// Contract (Requirements 4.8, 5.5, 6.9, 9.1, 9.2, 9.3, 9.7):
//
//   1. Total — every input returns a string. The function MUST NEVER
//      throw under any input shape (Requirement 9.3).
//
//   2. Empty / non-string key → return the empty-key sentinel
//      `<empty-i18n-key>` (Requirement 9.7). This branch fires before
//      any catalog lookup so the warn-once channel is not consumed by
//      buggy call sites passing `undefined` / `null` / `''`.
//
//   3. Lookup chain (Requirement 4.8 / 5.5 / 6.9):
//        a. catalogs[locale][key] if it is a non-empty string → return it.
//        b. catalogs[fallbackLocale][key] if it is a non-empty string and
//           `fallbackLocale !== locale` → warn-once and return it.
//        c. otherwise → warn-once and return the literal key.
//      The renderer passes `fallbackLocale = 'zh-CN'` (the v1 source
//      language); the main process passes `fallbackLocale = 'en-US'`
//      so missing zh-CN keys still surface ASCII rather than CJK.
//      When `fallbackLocale` is omitted the function defaults to
//      `'zh-CN'` to match the renderer-side default in design.md.
//
//   4. Warn-once dedup — `console.warn` fires AT MOST once per
//      `(locale, key)` pair via a process-local `Set<string>`
//      (Requirements 9.1, 9.2). The set is keyed by `${locale}::${key}`
//      so a miss in zh-CN and a miss in en-US for the same key produce
//      two separate warns, matching the design's intent of one warn
//      per missing-key/locale combination. The dedup is per process
//      (per module instance) — the renderer's bundle and the main
//      bundle each carry their own copy.
//
// This module is pure TypeScript: no React, no DOM, no Electron
// imports. It is safely tree-shaken into both `dist/main/i18n/**`
// (CJS via tsc) and the renderer bundle (Vite).
//
// `Locale_Code` is declared locally (not imported from `./index`) for
// the same reason `active-locale.ts` does: task 1.9 introduces
// `src/i18n/index.ts` as the public façade that re-exports the
// canonical union. Keeping the alias local here avoids a forward
// circular import while the public surface is being assembled.

import type { TranslationCatalog } from './catalogs/types';
import { zhCN } from './catalogs/zh-CN';
import { enUS } from './catalogs/en-US';

type Locale_Code = 'zh-CN' | 'en-US';

const CATALOGS: Record<Locale_Code, TranslationCatalog> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

const DEFAULT_FALLBACK_LOCALE: Locale_Code = 'zh-CN';
const EMPTY_KEY_SENTINEL = '<empty-i18n-key>';

// Process-local warn-once dedup. Catalogs hold ~200 keys × 2 locales,
// so the worst case is ~400 entries for the lifetime of the process —
// well under any meaningful memory budget for a Set of short strings.
const warnedMisses = new Set<string>();

/**
 * Resolve a Translation_Key to its localized string for `locale`,
 * falling back to `fallbackLocale` (default `'zh-CN'`) and finally to
 * the literal key. Returns the `<empty-i18n-key>` sentinel for empty
 * or non-string `key` inputs and never throws.
 *
 * @param key             Candidate Translation_Key. Typed as `unknown`
 *                        because main-side IPC payloads and renderer
 *                        catalog-driven lookups occasionally hand the
 *                        function values that have not yet been
 *                        narrowed to `string`.
 * @param locale          Active_Locale to consult first.
 * @param fallbackLocale  Locale consulted when `locale` does not have
 *                        a non-empty value for `key`. Defaults to
 *                        `'zh-CN'` (the renderer-side default per
 *                        design.md). Main-side call sites pass
 *                        `'en-US'` so unknown keys surface ASCII.
 */
export function resolve(
  key: unknown,
  locale: Locale_Code,
  fallbackLocale: Locale_Code = DEFAULT_FALLBACK_LOCALE,
): string {
  // Requirement 9.7 — empty or non-string keys never reach the
  // catalog. The sentinel is intentionally distinct from any
  // legitimate catalog value so misuse is loud in the rendered UI.
  if (typeof key !== 'string' || key.length === 0) {
    return EMPTY_KEY_SENTINEL;
  }

  // Defensive fallback to the v1 default if a caller smuggles an
  // out-of-set value past the `Locale_Code` type (e.g. `as never`).
  // Requirement 9.3 — must not throw.
  const activeCatalog = CATALOGS[locale] ?? CATALOGS[DEFAULT_FALLBACK_LOCALE];
  // Cast through `unknown` because `TranslationCatalog` is a closed
  // interface (no index signature) — the closed shape is what gives us
  // tsc-enforced symmetry at every call site of `t()`. Here we want
  // the reverse: a runtime-safe lookup keyed by an arbitrary string,
  // because callers may legitimately pass a key that does not exist
  // in the catalog (Requirements 4.8 / 9.2).
  const fromActive = (activeCatalog as unknown as Record<string, unknown>)[key];
  if (typeof fromActive === 'string' && fromActive.length > 0) {
    return fromActive;
  }

  // Active locale is missing the key (or the value is empty / wrong
  // type). Try the fallback locale, but only when it differs from the
  // active locale — otherwise the second lookup is guaranteed to
  // produce the same miss and would just double-warn.
  if (fallbackLocale !== locale) {
    const fallbackCatalog =
      CATALOGS[fallbackLocale] ?? CATALOGS[DEFAULT_FALLBACK_LOCALE];
    const fromFallback = (fallbackCatalog as unknown as Record<string, unknown>)[key];
    if (typeof fromFallback === 'string' && fromFallback.length > 0) {
      warnOnce(locale, key);
      return fromFallback;
    }
  }

  // Neither catalog had a usable value — fall through to the literal
  // key (Requirement 4.8 / 9.2). Warn once for the active locale.
  warnOnce(locale, key);
  return key;
}

function warnOnce(locale: Locale_Code, key: string): void {
  const tag = `${locale}::${key}`;
  if (warnedMisses.has(tag)) {
    return;
  }
  warnedMisses.add(tag);
  // eslint-disable-next-line no-console
  console.warn(`[i18n] missing key '${key}' for locale '${locale}'`);
}
