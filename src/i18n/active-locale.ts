// Process-local Active_Locale singleton for the main process.
//
// The renderer keeps its own copy of the active locale inside
// `<I18nProvider>` React state, refreshed by the `settings.updated`
// push channel. Main-side call sites (tray menu, native dialog filters,
// IPC handlers) instead read this module-local `let` via
// `getActiveLocale()` and the ambient `t()` published from
// `src/i18n/index.ts` (task 1.9).
//
// Requirement 5.3 — Tray menu and any main-side `t()` call must reflect
// the locale chosen in Settings within one rebuild cycle. The boot path
// in `src/main/app.ts` calls `setActiveLocale(settings.locale)` once
// after `loadOrSeedAppSettings`, and the `updateSettings` IPC handler
// re-calls it whenever `prev.locale !== next.locale` (task 6).
//
// Requirement 7.5 — The seeded default before settings load is `'zh-CN'`,
// matching the seed value that `normalizeAppSettings` writes for first-run
// users with no persisted locale.
//
// This module is main-side only: no React, no DOM, no Electron imports,
// so it can be unit-tested in plain Node without the Electron runtime.
//
// `Locale_Code` is defined locally (rather than imported from `./index`)
// to avoid a circular dependency. Task 1.9 introduces `src/i18n/index.ts`
// as the public façade and re-exports the canonical `Locale_Code` union;
// this file keeps a structurally identical local alias so the two stay in
// lockstep without forming an import cycle.

type Locale_Code = 'zh-CN' | 'en-US';

let activeLocale: Locale_Code = 'zh-CN';

export function getActiveLocale(): Locale_Code {
  return activeLocale;
}

export function setActiveLocale(next: Locale_Code): void {
  activeLocale = next;
}
