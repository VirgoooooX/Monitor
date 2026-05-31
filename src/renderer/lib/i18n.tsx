// Renderer-side React glue for the shared i18n runtime.
//
// This module is the renderer's single source of truth for
// Active_Locale: a React state atom kept inside `<I18nProvider>` and
// fed by two channels —
//
//   1. `desktop.getSettings()` on mount (synchronous first-paint
//      seed wins as soon as it resolves), and
//   2. `desktop.on('settings.updated', ...)` for live flips.
//
// The provider sits above `<App>` in `src/renderer/main.tsx` so every
// component that calls `useT()` / `useLocale()` re-renders exactly
// once per Active_Locale change, satisfying the live-switch contract
// in design.md §Architecture (no `BrowserWindow.reload()`, no React-
// root unmount; Requirements 7.1, 7.2, 7.4, 10).
//
// Why this lives under `src/renderer/lib/` and not `src/i18n/`:
// `src/i18n/**` is the shared-runtime package both processes import,
// and the only directory exempt from the renderer ↔ main isolation
// rule. React itself is renderer-only — the shared package therefore
// stays React-free, and this thin file adapts the pure surface
// (`createTranslator`, `Locale_Code`, etc.) into a React context.
//
// The translator value held in context is rebuilt on every locale
// change via `createTranslator(locale)` (a pure function, see
// `src/i18n/index.ts`). Because the returned translator closes over
// the locale, a stale closure can never resolve against a newer
// Active_Locale (Requirement 9.3). `useMemo` avoids constructing a
// fresh translator per render when only unrelated state changes.
//
// References:
//   - design.md §Architecture, §Components and Interfaces — Renderer
//     integration: `src/renderer/lib/i18n.tsx`
//   - requirements.md Requirements 7, 10, 11

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  createTranslator,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALE_CODES,
  type Locale_Code,
  type Translator,
} from '../../i18n';

/**
 * Shape of the value published on `I18nContext`.
 *
 * `bootstrapTimedOut` is exposed so the existing top-level boot
 * placeholder in `App.tsx` can dismiss itself after the 3000 ms
 * safety net fires (Requirement 10.5). Renderer surfaces that simply
 * want to translate text only need `t` and `locale`.
 */
interface I18nContextValue {
  readonly locale: Locale_Code;
  readonly t: Translator;
  readonly bootstrapTimedOut: boolean;
}

/**
 * Default context value used when a consumer is rendered outside an
 * `<I18nProvider>` (e.g. a unit test that only mounts a single
 * component). The translator is bound to the Default_Locale so calls
 * to `useT()` still produce strings rather than throwing.
 */
const DEFAULT_CONTEXT_VALUE: I18nContextValue = {
  locale: DEFAULT_LOCALE,
  t: createTranslator(DEFAULT_LOCALE),
  bootstrapTimedOut: false,
};

const I18nContext = createContext<I18nContextValue>(DEFAULT_CONTEXT_VALUE);

/**
 * `Set`-backed lookup for the closed Locale_Code v1 set. A `Set`
 * lookup is O(1) and avoids the type gymnastics of widening the
 * read-only tuple to a `string[]` for `Array.prototype.includes`
 * (the `as readonly string[]` dance you see in design.md). The
 * helper below performs the type narrowing so call sites read
 * cleanly.
 */
const SUPPORTED_LOCALE_SET: ReadonlySet<string> = new Set<string>(
  SUPPORTED_LOCALE_CODES,
);

function isLocaleCode(value: unknown): value is Locale_Code {
  return typeof value === 'string' && SUPPORTED_LOCALE_SET.has(value);
}

/**
 * Safety-net timeout in milliseconds (Requirement 10.5).
 *
 * If `desktop.getSettings()` neither resolves nor rejects within this
 * window — e.g. the main process is wedged behind a slow IPC handler
 * — we flip `bootstrapTimedOut` so the existing top-level placeholder
 * in `App.tsx` can dismiss itself and the App can render with the
 * Default_Locale ('zh-CN') already seeded into `useState`.
 */
const BOOTSTRAP_TIMEOUT_MS = 3000;

/**
 * Renderer-side i18n provider.
 *
 * Bootstrap behaviour (Requirements 10.1–10.5):
 *
 *   - Initial state: `useState<Locale_Code>(DEFAULT_LOCALE)` so the
 *     first React commit is synchronous with `'zh-CN'`. No async
 *     work blocks the first paint.
 *   - Effect on mount: call `desktop.getSettings()`. On success, if
 *     `settings.locale` is a member of the closed Locale_Code set,
 *     adopt it. On rejection or when `window.desktop` is undefined
 *     (e.g. jsdom), retain `DEFAULT_LOCALE`.
 *   - Subscribe to `settings.updated` over the preload bridge.
 *     Payloads whose `locale` field is missing, `null`, non-string,
 *     or out-of-set are silently ignored (Requirement 10.6). Valid
 *     payloads update Active_Locale only when the value differs.
 *   - 3000 ms safety net flips `bootstrapTimedOut` so the boot
 *     placeholder can be dismissed even if `getSettings()` never
 *     settles. The getSettings resolution still wins if it lands
 *     first; the flag is independent.
 *
 * Document-level side effect (Requirements 11.1–11.5):
 *
 *   - Whenever Active_Locale changes, mirror the value onto
 *     `document.documentElement.lang` so screen readers pronounce
 *     content in the correct language. `dir` is pinned to `'ltr'`
 *     because both v1 locales are left-to-right scripts.
 *   - If somehow Active_Locale holds a value outside the closed set,
 *     fall back to `'zh-CN'` for the lang attribute (Requirement
 *     11.5). TypeScript prevents this in normal control flow; the
 *     guard is a defensive belt for runtime mutations.
 *
 * Memoisation:
 *
 *   - The published `value` is memoised on `[locale, bootstrapTimedOut]`
 *     so context consumers re-render exactly when one of those
 *     primitives changes, never on unrelated parent re-renders.
 *   - The translator is rebuilt via `createTranslator(locale)` inside
 *     the same memo so a fresh, locale-bound translator is published
 *     atomically with the locale flip (no torn read where a stale
 *     translator resolves against a newer locale).
 */
export function I18nProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const [locale, setLocale] = useState<Locale_Code>(DEFAULT_LOCALE);
  const [bootstrapTimedOut, setBootstrapTimedOut] = useState<boolean>(false);

  // Bootstrap effect: arm the safety net, fetch the persisted locale,
  // and subscribe to live updates. Empty deps so the subscription is
  // installed exactly once per provider mount; `setLocale`'s functional
  // form below performs the "ignore if already on this value" check
  // without forcing a re-subscription on every locale flip.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const safetyNet = window.setTimeout(() => {
      if (cancelled) return;
      setBootstrapTimedOut(true);
    }, BOOTSTRAP_TIMEOUT_MS);

    const desktop = window.desktop;
    if (desktop) {
      desktop
        .getSettings()
        .then((s) => {
          if (cancelled) return;
          const candidate = (s as { locale?: unknown }).locale;
          if (isLocaleCode(candidate)) {
            setLocale((prev) => (prev === candidate ? prev : candidate));
          }
          // Out-of-set / missing / non-string values: retain
          // DEFAULT_LOCALE per Requirement 10.1's "is a member of the
          // closed set" precondition.
        })
        .catch(() => {
          // Requirement 10.3: rejection retains DEFAULT_LOCALE. The
          // boot placeholder/`preload bridge unavailable` UX lives in
          // `App.tsx`; this provider only owns Active_Locale.
        });

      unsubscribe = desktop.on('settings.updated', (next) => {
        if (cancelled) return;
        const candidate = (next as { locale?: unknown }).locale;
        if (!isLocaleCode(candidate)) {
          // Requirement 10.6: silently retain Active_Locale when the
          // payload's `locale` is missing/null/non-string/out-of-set.
          return;
        }
        setLocale((prev) => (prev === candidate ? prev : candidate));
      });
    }
    // Else: `window.desktop` undefined (jsdom test, broken preload).
    // Per Requirement 10.3 we retain DEFAULT_LOCALE; the safety-net
    // timer still fires so any consumer of `bootstrapTimedOut`
    // dismisses its placeholder eventually.

    return () => {
      cancelled = true;
      window.clearTimeout(safetyNet);
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Mirror Active_Locale onto `document.documentElement` for a11y.
  // Runs after every commit where `locale` actually changed (React
  // bail-out via `Object.is` keeps this cheap when `setLocale` is
  // called with the same value).
  useEffect(() => {
    const langValue: Locale_Code = isLocaleCode(locale) ? locale : 'zh-CN';
    document.documentElement.lang = langValue;
    document.documentElement.dir = 'ltr';
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: createTranslator(locale),
      bootstrapTimedOut,
    }),
    [locale, bootstrapTimedOut],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Read the active Translator.
 *
 * The returned function is bound to the current Active_Locale via
 * `createTranslator`. It is stable across renders for the same
 * locale (rebuilt only inside the provider's `useMemo`), so it can
 * be safely used as a `useEffect` / `useCallback` dependency without
 * triggering on every parent re-render.
 */
export function useT(): Translator {
  return useContext(I18nContext).t;
}

/**
 * Read the current Active_Locale.
 *
 * Useful for components that need to branch on the locale itself
 * (e.g. choosing a language-specific date format helper) rather than
 * resolving a Translation_Key through the translator.
 */
export function useLocale(): Locale_Code {
  return useContext(I18nContext).locale;
}

/**
 * Read whether the 3000 ms bootstrap safety net has fired.
 *
 * Exposed so the existing top-level boot fallback in `App.tsx` can
 * dismiss its placeholder once the safety net trips, even if
 * `desktop.getSettings()` never settles (Requirement 10.5). Returns
 * `false` when the provider is not mounted (e.g. unit tests that
 * render a single component without the provider tree).
 */
export function useBootstrapTimedOut(): boolean {
  return useContext(I18nContext).bootstrapTimedOut;
}
