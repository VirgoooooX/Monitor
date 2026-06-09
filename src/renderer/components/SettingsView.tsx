// Settings view — sectioned form with side-rail navigation.
//
// Layout:
//   ┌──────────────────────────────────────────────────────────┐
//   │ Title + summary                                          │
//   │ ┌──────────┬──────────────────────────────────────────┐ │
//   │ │ TOC rail │  Section blocks (controller / probes /   │ │
//   │ │  · 控制器 │   groups / router / intervals /          │ │
//   │ │  · 探测   │   switch / collectors)                    │ │
//   │ │  …       │                                          │ │
//   │ └──────────┴──────────────────────────────────────────┘ │
//   │  ── Sticky save bar (only shows when dirty) ──           │
//   └──────────────────────────────────────────────────────────┘
//
// Accessible, client-side validated, write-only secret handling.
// References: design.md §Validation rules, §Property 18, §Property 19;
// PLAN.md §UI Implementation Guide §设置.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Server,
  Radar,
  Layers,
  Router,
  Timer,
  ArrowLeftRight,
  Sparkles,
  Network,
  Palette,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  KeyRound,
} from 'lucide-react';

import type {
  AppearanceSettings,
  AppSettings,
  ColorMode,
  CompactTheme,
  CreateProviderAuthApiKeyInput,
  KiroTokenRefreshSettings,
  Locale_Code,
  ManagementConfigFileEntry,
  ManualApiKeyProvider,
  ProviderAuthMetadata,
  ProviderId,
  RefreshIntervalSettings,
} from '../lib/types';
import { useT } from '../lib/i18n';
import type { TranslationKey, Translator } from '../../i18n';
import {
  PROVIDER_LABELS,
  resolveProviderAuthErrorLabel,
  ProviderAuthList,
} from './ProviderAuthList';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface ValidationErrors {
  controllerUrl?: string;
  probeUrls?: string;
  routerHealthPort?: string;
  refreshIntervals?: string;
  switchVerifyDelayMs?: string;
  managementUrl?: string;
  managementRequestTimeoutMs?: string;
  configSwitchVerifyWindowMs?: string;
  configFileWhitelist?: string;
}

/**
 * Renderer-side fallback applied when settings predate the theme
 * system. The strict zod schema rejects rows missing `appearance`, so
 * the main process normalises on boot, but the renderer also tolerates
 * the legacy shape locally so the form can still render while the
 * normalize-and-rebroadcast flow completes.
 */
const DEFAULT_APPEARANCE: AppearanceSettings = {
  colorMode: 'dark',
  compactTheme: 'mint-monitor',
  fontScale: 1,
  compactZoom: 1,
};

/**
 * Default policy for the Kiro IDE auto-refresh feature when the
 * persisted settings row predates this block. Mirrors
 * `buildDefaultAppSettings` / `normalizeAppSettings` in `app.ts` so
 * a renderer running against a not-yet-normalised payload still
 * produces a coherent UI.
 */
const DEFAULT_KIRO_TOKEN_REFRESH: KiroTokenRefreshSettings = {
  enabled: true,
  writeBackAuthFile: true,
};

interface CompactThemeOption {
  readonly id: CompactTheme;
  /** Catalog key suffix under `settings.appearance.theme.<key>.label/.description`. */
  readonly i18nKey: string;
}

/**
 * Compact-window theme presets in display order. Six v2 design-language
 * presets followed by five v1 legacy presets. The visible label and
 * description are resolved at render time via
 * `t('settings.appearance.theme.<i18nKey>.label')` /
 * `…description` (i18n-multilingual-support, Requirement 4.2). Catalog
 * keys live in `src/i18n/catalogs/{zh-CN,en-US}.ts`.
 */
const COMPACT_THEME_OPTIONS: readonly CompactThemeOption[] = [
  // v2 design-language presets
  { id: 'liquid-glass', i18nKey: 'liquidGlass' },
  { id: 'material-you', i18nKey: 'materialYou' },
  { id: 'soft-neumorph', i18nKey: 'softNeumorph' },
  { id: 'paper-dashboard', i18nKey: 'paperDashboard' },
  { id: 'mint-monitor', i18nKey: 'mintMonitor' },
  { id: 'device-oled', i18nKey: 'deviceOled' },
  // v1 legacy presets (retained for users who preferred them)
  { id: 'obsidian-glass', i18nKey: 'obsidianGlass' },
  { id: 'aurora-ring', i18nKey: 'auroraRing' },
  { id: 'holo-grid', i18nKey: 'holoGrid' },
  { id: 'liquid-metal', i18nKey: 'liquidMetal' },
  { id: 'signal-pulse', i18nKey: 'signalPulse' },
];

const HTTP_URL_RE = /^https?:\/\//;
// Mirror of `CONFIG_PATH_RE` in `src/main/schemas.ts`. Keeping the
// regex local to the renderer avoids a runtime import from `src/main`
// (sandbox boundary) at the cost of a duplicated literal — drift is
// caught by the IPC layer's zod validation, which always re-checks
// the value before persisting.
const CONFIG_PATH_RE = /^\/etc\/openclash\/config\/[A-Za-z0-9._\-]+\.(yaml|yml)$/;

/**
 * Validate the (trimmed) management URL. Mirrors `managementUrlSchema`
 * in `src/main/schemas.ts`: must be http(s)://, must not embed
 * userinfo, must not include a query or fragment. The empty string
 * is permitted here as the "not yet configured" sentinel — the IPC
 * schema rejects it, but the renderer treats an empty URL as the
 * "skip this section" signal so the user can land on Settings on
 * first run without a hard error.
 *
 * Error strings are sourced from the active Translation_Catalog so
 * the validation surface tracks the user's locale
 * (i18n-multilingual-support, Requirement 4.2).
 */
function validateManagementUrl(
  value: string,
  t: Translator,
): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return t('settings.validation.urlInvalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return t('settings.validation.urlScheme');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return t('settings.validation.urlNoCreds');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return t('settings.validation.urlNoQuery');
  }
  return undefined;
}

function validateSettings(
  settings: AppSettings,
  t: Translator,
): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!HTTP_URL_RE.test(settings.controllerUrl)) {
    errors.controllerUrl = t('settings.validation.urlInvalid');
  }

  if (settings.probeUrls.length === 0) {
    errors.probeUrls = '至少需要一个 probe URL';
  } else {
    const invalid = settings.probeUrls.filter((u) => !HTTP_URL_RE.test(u));
    if (invalid.length > 0) {
      errors.probeUrls = `以下 URL 格式无效: ${invalid.join(', ')}`;
    }
  }

  const port = settings.routerHealth.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.routerHealthPort = '端口必须在 1 - 65535 之间';
  }

  const intervals = settings.refreshIntervals;
  const intervalKeys = Object.keys(intervals) as (keyof RefreshIntervalSettings)[];
  const badIntervals = intervalKeys.filter((k) => intervals[k] < 1000);
  if (badIntervals.length > 0) {
    errors.refreshIntervals = `以下刷新间隔必须 ≥ 1000 ms: ${badIntervals.join(', ')}`;
  }

  if (
    !Number.isInteger(settings.switchVerifyDelayMs) ||
    settings.switchVerifyDelayMs < 0 ||
    settings.switchVerifyDelayMs > 10000
  ) {
    errors.switchVerifyDelayMs = '切换验证延迟必须在 0 - 10000 ms 之间';
  }

  // Management interface
  const urlError = validateManagementUrl(settings.managementInterface.url, t);
  if (urlError !== undefined) {
    errors.managementUrl = urlError;
  }

  const reqTimeout = settings.managementInterface.requestTimeoutMs;
  if (
    !Number.isInteger(reqTimeout) ||
    reqTimeout < 1000 ||
    reqTimeout > 30000
  ) {
    errors.managementRequestTimeoutMs = '请求超时必须在 1000 - 30000 ms 之间';
  }

  const verifyWindow = settings.configSwitchVerifyWindowMs;
  if (
    !Number.isInteger(verifyWindow) ||
    verifyWindow < 1000 ||
    verifyWindow > 30000
  ) {
    errors.configSwitchVerifyWindowMs =
      '配置切换校验窗口必须在 1000 - 30000 ms 之间';
  }

  const whitelist = settings.managementInterface.configFileWhitelist;
  const whitelistIssues: string[] = [];
  whitelist.forEach((entry, i) => {
    if (entry.alias.trim().length === 0) {
      whitelistIssues.push(`第 ${i + 1} 行：别名不能为空`);
    }
    if (!CONFIG_PATH_RE.test(entry.path.trim())) {
      whitelistIssues.push(
        `第 ${i + 1} 行：路径必须形如 /etc/openclash/config/*.yaml`,
      );
    }
  });
  if (whitelistIssues.length > 0) {
    errors.configFileWhitelist = whitelistIssues.join('；');
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Section + collector metadata
// ---------------------------------------------------------------------------

interface SectionDef {
  readonly id: string;
  /**
   * Catalog key suffix under `settings.section.<i18nKey>.label/.hint`.
   * Section labels and hints are resolved at render time via
   * {@link useT} so the rail tracks the user's locale
   * (i18n-multilingual-support, Requirement 4.2).
   */
  readonly i18nKey: string;
  readonly icon: JSX.Element;
}

const SECTIONS: readonly SectionDef[] = [
  {
    id: 'appearance',
    i18nKey: 'appearance',
    icon: <Palette size={14} strokeWidth={1.75} />,
  },
  {
    id: 'controller',
    i18nKey: 'controller',
    icon: <Server size={14} strokeWidth={1.75} />,
  },
  {
    id: 'probes',
    i18nKey: 'probes',
    icon: <Radar size={14} strokeWidth={1.75} />,
  },
  {
    id: 'groups',
    i18nKey: 'groups',
    icon: <Layers size={14} strokeWidth={1.75} />,
  },
  {
    id: 'router',
    i18nKey: 'router',
    icon: <Router size={14} strokeWidth={1.75} />,
  },
  {
    id: 'intervals',
    i18nKey: 'intervals',
    icon: <Timer size={14} strokeWidth={1.75} />,
  },
  {
    id: 'switching',
    i18nKey: 'switching',
    icon: <ArrowLeftRight size={14} strokeWidth={1.75} />,
  },
  {
    id: 'management',
    i18nKey: 'management',
    icon: <Network size={14} strokeWidth={1.75} />,
  },
  {
    id: 'accounts',
    i18nKey: 'accounts',
    icon: <Sparkles size={14} strokeWidth={1.75} />,
  },
];

// Refresh-interval field metadata. The visible label and hint for each
// `RefreshIntervalSettings` key are resolved at render time via
// `t('settings.intervals.<i18nKey>.label/.hint')`. Catalog keys live in
// `src/i18n/catalogs/{zh-CN,en-US}.ts`.
const INTERVAL_META: Record<keyof RefreshIntervalSettings, { i18nKey: string }> = {
  networkMs: { i18nKey: 'network' },
  openclashMs: { i18nKey: 'openclash' },
  currentNodeMs: { i18nKey: 'currentNode' },
  nodeScanMs: { i18nKey: 'nodeScan' },
  usageMs: { i18nKey: 'usage' },
  retentionMs: { i18nKey: 'retention' },
};

// ---------------------------------------------------------------------------
// Provider Auth section metadata
// ---------------------------------------------------------------------------

/**
 * Picker order for the CPA file-import path. Mirrors the closed
 * `ProviderId` union from `src/main/types.ts` — every provider is
 * eligible for file import because the CPA parser handles each
 * dialect.
 */
const FILE_IMPORT_PICKER_ORDER: readonly ProviderId[] = [
  'claude-code',
  'codex',
  'gemini-cli',
  'antigravity',
  'kiro-ide',
  'gemini-api',
  'deepseek',
  'xiaomi',
  'opencode',
  'openai-compatible',
];

/**
 * Picker order for the manual API-key entry form. Restricted to the
 * `ManualApiKeyProvider` subset — OAuth-style providers (`claude-code`,
 * `codex`, `gemini-cli`, `antigravity`) require the full CPA file
 * import flow and are intentionally absent here.
 */
const MANUAL_API_KEY_PICKER_ORDER: readonly ManualApiKeyProvider[] = [
  'gemini-api',
  'deepseek',
  'xiaomi',
  'opencode',
  'openai-compatible',
];

/**
 * Unwrap the renderer-side `IpcEnvelopeError` shape (see
 * `src/preload/index.ts`) into the `{ code, message }` triple the
 * Provider_Auth section displays. The preload throws an
 * `IpcEnvelopeError` (a plain `Error` subclass with a public `code`
 * field) whenever main returns `{ ok: false, error: { code, message } }`.
 * We can't `instanceof` it here because the class is private to the
 * preload bundle, so we duck-type on the public `code` field
 * instead.
 *
 * For everything else (renderer crash, unexpected `throw`), we fall
 * back to a generic `'unknown'` envelope so the UI still renders a
 * non-empty error string. Per cpa-quota-import requirements §1.4
 * the message length is already bounded to 80 characters by the
 * IPC schema; we trim defensively anyway.
 */
function extractIpcError(
  err: unknown,
  t?: Translator,
): { code: string; message: string } {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    if (typeof code === 'string' && typeof message === 'string') {
      return { code, message: message.slice(0, 200) };
    }
    if (typeof message === 'string') {
      return { code: 'unknown', message: message.slice(0, 200) };
    }
  }
  // Fallback for non-string `message`. The `t` argument is optional so
  // the mount-time `useEffect` (which has `[]` deps to avoid re-listing
  // accounts on every locale flip) can reuse this helper without
  // capturing a stale translator closure; in that path the localised
  // "Unknown error" sentinel comes through `formatProviderAuthError`'s
  // re-resolution at render time anyway.
  return {
    code: 'unknown',
    message: t ? t('settings.accounts.apiKey.error.unknown') : 'Unknown error',
  };
}

/**
 * Render copy for a Provider_Auth IPC error envelope. Maps the
 * closed `ProviderAuthErrorCode` set to the same localised labels
 * `ProviderAuthList` uses for status badges (single source of
 * truth: `PROVIDER_AUTH_ERROR_LABEL_KEYS`); falls back to the raw
 * envelope message for codes outside the closed set (`'protocol'`,
 * `'unknown'`, IPC validation failures from outside the Provider_Auth
 * code list, etc.).
 */
function formatProviderAuthError(
  t: Translator,
  envelope: {
    code: string;
    message: string;
  },
): string {
  const known = resolveProviderAuthErrorLabel(t, envelope.code);
  if (known !== null) {
    return envelope.message.length > 0
      ? t('settings.accounts.apiKey.error.prefix', {
          label: known,
          message: envelope.message,
        })
      : known;
  }
  return envelope.message.length > 0
    ? envelope.message
    : t('settings.accounts.apiKey.error.importFailed', { code: envelope.code });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsView(): JSX.Element {
  const t = useT();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pristine, setPristine] = useState<AppSettings | null>(null);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  // LuCI management credentials are write-only (mirrors the
  // controller secret pattern): the renderer never sees existing
  // values, only blanks to enter a fresh credential. Empty strings
  // mean "leave the stored value unchanged on save".
  const [luciUsername, setLuciUsername] = useState('');
  const [luciPassword, setLuciPassword] = useState('');
  const [showLuciPassword, setShowLuciPassword] = useState(false);
  const [credsCleared, setCredsCleared] = useState(false);
  const [loading, setLoading] = useState(true);
  // Non-blocking error surface for the eager-commit Locale_Picker.
  // Lives outside the form's `errors` map and the `saveError` channel
  // (i18n-multilingual-support, Requirements 8.6, 8.7) so the locale
  // failure neither sets the global dirty flag nor blocks other
  // in-flight edits / the Save button. Cleared on a successful flip.
  const [localeError, setLocaleError] = useState<string | null>(null);

  // ── Provider_Auth section local state ─────────────────────────────
  // These mutations DO NOT flow through the existing `setSettings` /
  // `dirty` machinery — Provider_Auth changes commit immediately on
  // import / refresh / delete (mirrors the `clearManagementCredentials`
  // precedent in the management section). Per cpa-quota-import
  // requirements §8.1 and §12.7 the renderer never holds secret
  // material; `rows` only carries the redacted `ProviderAuthMetadata`
  // shape.
  const [providerPick, setProviderPick] = useState<ProviderId>(
    FILE_IMPORT_PICKER_ORDER[0]!,
  );
  const [providerAuthRows, setProviderAuthRows] = useState<
    ProviderAuthMetadata[]
  >([]);
  const [providerAuthBusyId, setProviderAuthBusyId] = useState<string | null>(
    null,
  );
  const [providerAuthError, setProviderAuthError] = useState<
    { code: string; message: string } | null
  >(null);

  // ── Manual API-key entry form ─────────────────────────────────────
  // The form is closed by default; the user opens it from the
  // "输入 API Key" button. State is local to the section so the
  // values do not flow through the global `dirty` flag.
  const [apiKeyFormOpen, setApiKeyFormOpen] = useState(false);
  const [apiKeyProvider, setApiKeyProvider] = useState<ManualApiKeyProvider>(
    MANUAL_API_KEY_PICKER_ORDER[0]!,
  );
  const [apiKeyLabel, setApiKeyLabel] = useState('');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [apiKeyBaseUrl, setApiKeyBaseUrl] = useState('');
  const [apiKeyShow, setApiKeyShow] = useState(false);
  // Xiaomi MiMo only — the official `/api/v1/balance` endpoint
  // authenticates via a `passToken` + `userId` cookie pair (not an
  // API key). The fields are hidden for every other provider.
  const [xiaomiPassToken, setXiaomiPassToken] = useState('');
  const [xiaomiUserId, setXiaomiUserId] = useState('');
  const [xiaomiPassTokenShow, setXiaomiPassTokenShow] = useState(false);
  // DeepSeek only — optional console `userToken` (from
  // `localStorage.userToken` on platform.deepseek.com). When
  // present the adapter unlocks multi-wallet detail and the
  // daily-usage sparkline; absent, only the public balance shows.
  const [deepseekUserToken, setDeepseekUserToken] = useState('');
  const [deepseekUserTokenShow, setDeepseekUserTokenShow] = useState(false);
  // OpenCode Go only — opaque Iron-encrypted `auth` cookie and the
  // workspace dashboard URL. The dashboard SSR-renders usage
  // percentages directly into the HTML; the adapter scrapes them.
  // The Iron session has a TTL that is renewed by `Set-Cookie` on
  // every browser visit; our stored cookie never gets renewed, so
  // it eventually goes stale and the dashboard returns HTTP 500.
  // The adapter surfaces that as `auth_expired` so users re-paste.
  const [opencodeAuthCookie, setOpencodeAuthCookie] = useState('');
  const [opencodeWorkspaceUrl, setOpencodeWorkspaceUrl] = useState('');
  const [opencodeAuthCookieShow, setOpencodeAuthCookieShow] = useState(false);

  // Edit mode state — tracks whether we're editing an existing account
  // vs creating a new one. When `editingProviderAuthId` is non-null,
  // the API key form enters edit mode (provider fixed, secret fields
  // show "leave empty to keep current" placeholder).
  const [editingProviderAuthId, setEditingProviderAuthId] = useState<string | null>(null);
  const [editingMode, setEditingMode] = useState<'manual' | 'reimport' | null>(null);

  // Load initial settings
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) {
      setLoading(false);
      return;
    }
    desktop
      .getSettings()
      .then((s) => {
        setSettings(s);
        setPristine(s);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[SettingsView] getSettings failed:', err);
        setLoading(false);
      });
  }, []);

  // Load Provider_Auth rows on mount. This stays decoupled from the
  // settings load above — `provider_auth` lives in its own SQLite
  // table (cpa-quota-import requirements §3.1) and the renderer
  // mirrors that separation so a settings-load failure does not
  // hide imported accounts and vice versa.
  useEffect(() => {
    const desktop = window.desktop;
    if (!desktop) return;
    let cancelled = false;
    desktop
      .listProviderAuths()
      .then((rows) => {
        if (!cancelled) setProviderAuthRows(rows);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[SettingsView] listProviderAuths failed:', err);
        // No translator passed: the mount-time effect runs once with
        // `[]` deps so we cannot capture a current `t`; the fallback
        // "Unknown error" string is fine for the rare initial-load
        // failure path.
        if (!cancelled) setProviderAuthError(extractIpcError(err));
      });

    // Subscribe to provider-auth push events. Mutations from this
    // window already optimistic-update `providerAuthRows`, but the
    // push carries the canonical post-mutation row list (with
    // `lastQuotaAt` / `lastErrorCode` populated by the background
    // quota refresh that main schedules) so we replace state with
    // the embedded `rows` whenever a refresh-induced update
    // arrives. The `desktop.on` API is absent in browser preview;
    // guard accordingly.
    let unsubscribe: (() => void) | undefined;
    if ('on' in desktop && typeof desktop.on === 'function') {
      try {
        unsubscribe = desktop.on('provider-auth.updated', (payload) => {
          if (cancelled) return;
          if (payload?.rows !== undefined) {
            setProviderAuthRows([...payload.rows]);
          }
        });
      } catch {
        // Ignore — fall back to optimistic local updates.
      }
    }

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Detect dirty state cheaply via JSON comparison; the settings tree
  // is small (a couple dozen scalars + two short arrays) so this is
  // fine and avoids hand-rolling a deep-equal.
  const dirty = useMemo(() => {
    if (!settings || !pristine) return false;
    if (secret.trim().length > 0) return true;
    if (luciUsername.length > 0) return true;
    if (luciPassword.length > 0) return true;
    return JSON.stringify(settings) !== JSON.stringify(pristine);
  }, [settings, pristine, secret, luciUsername, luciPassword]);

  const errorCount = useMemo(
    () => Object.values(errors).filter(Boolean).length,
    [errors],
  );

  // Auto-dismiss the "已保存" confirmation after a short delay so the
  // sticky save bar doesn't linger indefinitely once the user has
  // acknowledged the success state.
  useEffect(() => {
    if (!saveSuccess) return;
    const timer = window.setTimeout(() => setSaveSuccess(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saveSuccess]);

  // ---------------------------------------------------------------------------
  // Field updaters
  // ---------------------------------------------------------------------------

  const updateField = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
      setSaveSuccess(false);
    },
    [],
  );

  /**
   * Patch the appearance block. Mirrors the spread-and-merge pattern
   * used by the other nested updaters; centralised here so the two
   * appearance controls (color mode + compact theme) share the same
   * dirty/save plumbing.
   */
  const updateAppearance = useCallback(
    (patch: Partial<AppearanceSettings>) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const current: AppearanceSettings = prev.appearance ?? DEFAULT_APPEARANCE;
        return { ...prev, appearance: { ...current, ...patch } };
      });
      setSaveSuccess(false);
    },
    [],
  );

  const updateInterval = useCallback(
    (key: keyof RefreshIntervalSettings, value: number) => {
      setSettings((prev) =>
        prev
          ? { ...prev, refreshIntervals: { ...prev.refreshIntervals, [key]: value } }
          : prev,
      );
      setSaveSuccess(false);
    },
    [],
  );

  /**
   * Patch the Kiro IDE auto-refresh policy. Same shape as
   * `updateAppearance` — the renderer locally tolerates a
   * not-yet-normalised settings row by falling back to
   * {@link DEFAULT_KIRO_TOKEN_REFRESH}.
   */
  const updateKiroTokenRefresh = useCallback(
    (patch: Partial<KiroTokenRefreshSettings>) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const current: KiroTokenRefreshSettings =
          prev.kiroTokenRefresh ?? DEFAULT_KIRO_TOKEN_REFRESH;
        return {
          ...prev,
          kiroTokenRefresh: { ...current, ...patch },
        };
      });
      setSaveSuccess(false);
    },
    [],
  );

  const toggleProviderAuthEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const desktop = window.desktop;
      if (!desktop) return;
      // Optimistically flip the local row so the switch animates
      // instantly; the IPC re-fetch below reconciles against the
      // canonical metadata main returned (or rolls back on failure).
      setProviderAuthRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, enabled } : r)),
      );
      setProviderAuthBusyId(id);
      setProviderAuthError(null);
      try {
        const updated = await desktop.setProviderAuthEnabled({ id, enabled });
        if (updated !== null) {
          setProviderAuthRows((prev) =>
            prev.map((r) => (r.id === id ? updated : r)),
          );
        }
      } catch (err: unknown) {
        // Rollback the optimistic flip.
        setProviderAuthRows((prev) =>
          prev.map((r) => (r.id === id ? { ...r, enabled: !enabled } : r)),
        );
        setProviderAuthError(extractIpcError(err, t));
      } finally {
        setProviderAuthBusyId(null);
      }
    },
    [t],
  );

  // Probe URL list management
  const updateProbeUrl = useCallback((index: number, value: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = [...prev.probeUrls];
      next[index] = value;
      return { ...prev, probeUrls: next };
    });
    setSaveSuccess(false);
  }, []);

  const addProbeUrl = useCallback(() => {
    setSettings((prev) => {
      if (!prev) return prev;
      return { ...prev, probeUrls: [...prev.probeUrls, ''] };
    });
  }, []);

  const removeProbeUrl = useCallback((index: number) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = prev.probeUrls.filter((_, i) => i !== index);
      return { ...prev, probeUrls: next };
    });
  }, []);

  // Primary groups management
  const updatePrimaryGroup = useCallback((index: number, value: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = [...prev.primaryGroups];
      next[index] = value;
      return { ...prev, primaryGroups: next };
    });
    setSaveSuccess(false);
  }, []);

  const addPrimaryGroup = useCallback(() => {
    setSettings((prev) => {
      if (!prev) return prev;
      return { ...prev, primaryGroups: [...prev.primaryGroups, ''] };
    });
  }, []);

  const removePrimaryGroup = useCallback((index: number) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = prev.primaryGroups.filter((_, i) => i !== index);
      return { ...prev, primaryGroups: next };
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Management interface (network-quick-actions task 16.1)
  // ---------------------------------------------------------------------------

  const updateManagementUrl = useCallback((value: string) => {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            managementInterface: { ...prev.managementInterface, url: value },
          }
        : prev,
    );
    setSaveSuccess(false);
  }, []);

  const updateManagementRequestTimeout = useCallback((value: number) => {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            managementInterface: {
              ...prev.managementInterface,
              requestTimeoutMs: value,
            },
          }
        : prev,
    );
    setSaveSuccess(false);
  }, []);

  const updateConfigSwitchVerifyWindow = useCallback((value: number) => {
    setSettings((prev) =>
      prev ? { ...prev, configSwitchVerifyWindowMs: value } : prev,
    );
    setSaveSuccess(false);
  }, []);

  const updateWhitelistEntry = useCallback(
    (index: number, patch: Partial<ManagementConfigFileEntry>) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const list = prev.managementInterface.configFileWhitelist;
        const current = list[index];
        if (!current) return prev;
        const next: ManagementConfigFileEntry[] = list.slice();
        next[index] = { ...current, ...patch };
        return {
          ...prev,
          managementInterface: {
            ...prev.managementInterface,
            configFileWhitelist: next,
          },
        };
      });
      setSaveSuccess(false);
    },
    [],
  );

  const addWhitelistEntry = useCallback(() => {
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        managementInterface: {
          ...prev.managementInterface,
          configFileWhitelist: [
            ...prev.managementInterface.configFileWhitelist,
            { alias: '', path: '' },
          ],
        },
      };
    });
    setSaveSuccess(false);
  }, []);

  const removeWhitelistEntry = useCallback((index: number) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = prev.managementInterface.configFileWhitelist.filter(
        (_, i) => i !== index,
      );
      return {
        ...prev,
        managementInterface: {
          ...prev.managementInterface,
          configFileWhitelist: next,
        },
      };
    });
    setSaveSuccess(false);
  }, []);

  /**
   * Wipe the LuCI credential rows from `secrets` and invalidate any
   * cached session cookie. Mirrors the IPC contract documented in
   * network-quick-actions/design.md §IPC Surface — the renderer is
   * the only legitimate caller of `clearManagementCredentials`. On
   * success we also clear the local input fields so a stale value
   * cannot accidentally be re-saved on the next "保存" click.
   */
  const handleClearManagementCredentials = useCallback(async () => {
    const desktop = window.desktop;
    if (!desktop) return;
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await desktop.clearManagementCredentials();
      setLuciUsername('');
      setLuciPassword('');
      setCredsCleared(true);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('settings.save.unknownError');
      setSaveError(message);
    }
  }, [t]);

  /**
   * Eager-commit handler for the Locale_Picker
   * (i18n-multilingual-support, Requirements 8.5, 8.6, 8.7).
   *
   * Mirrors {@link handleClearManagementCredentials}: optimistically
   * mutates local state so the radio reflects the click immediately,
   * then synchronously dispatches `desktop.updateSettings({ locale })`
   * inside the same user-event handler — there is no Save round-trip
   * for this control.
   *
   * To keep the locale axis invisible to the form's `dirty` flag (the
   * task explicitly forbids routing locale through `dirty`), we patch
   * BOTH `settings.locale` AND `pristine.locale` in tandem. The dirty
   * calculation is a JSON-string compare of those two objects; mutating
   * them together leaves any other in-flight edits the user is making
   * fully visible to `dirty` while the locale flip itself is a no-op
   * for that calculation.
   *
   * On success we deliberately do NOT swap `settings` with the canonical
   * `updated` row returned by the IPC: that row carries the *previously
   * persisted* values for every non-locale field, which would clobber
   * any in-flight edits the user has made elsewhere on the form
   * (Requirement 8.7).
   *
   * On rejection we revert both `settings.locale` and `pristine.locale`
   * to the previous Locale_Code and surface a non-blocking error via
   * {@link localeError} without touching the form's `errors` map,
   * `saveError`, or any other field's value.
   */
  const handleLocaleChange = useCallback(
    async (next: Locale_Code) => {
      if (!settings || next === settings.locale) return;
      const previous = settings.locale;
      // Optimistic local update — the radio reflects the click before
      // the IPC round-trip resolves (Requirement 8.5). We patch
      // `pristine` alongside `settings` so the locale flip is invisible
      // to the dirty calculation (Requirement 8.7).
      setSettings((prev) => (prev ? { ...prev, locale: next } : prev));
      setPristine((prev) => (prev ? { ...prev, locale: next } : prev));
      setLocaleError(null);
      const desktop = window.desktop;
      if (!desktop) {
        setSettings((prev) => (prev ? { ...prev, locale: previous } : prev));
        setPristine((prev) => (prev ? { ...prev, locale: previous } : prev));
        setLocaleError(t('settings.locale.errorPersistFailed'));
        return;
      }
      try {
        await desktop.updateSettings({ locale: next });
        // Optimistic state already reflects the new locale; the IPC
        // resolves with the canonical row but we intentionally drop it
        // to avoid stomping in-flight edits (Requirement 8.7). The
        // `settings.updated` broadcast is consumed by I18nProvider for
        // live re-render; SettingsView's locale state is fully owned
        // by this handler.
      } catch {
        // Revert optimistic update on both branches; surface a
        // non-blocking error. Do NOT route through `saveError` /
        // `errors` / `dirty` (Requirements 8.6, 8.7).
        setSettings((prev) => (prev ? { ...prev, locale: previous } : prev));
        setPristine((prev) => (prev ? { ...prev, locale: previous } : prev));
        setLocaleError(t('settings.locale.errorPersistFailed'));
      }
    },
    [settings, t],
  );

  // ---------------------------------------------------------------------------
  // Provider_Auth import / refresh / delete handlers
  // ---------------------------------------------------------------------------
  //
  // These handlers follow the `clearManagementCredentials` precedent
  // (cpa-quota-import requirements §12.7): mutations commit
  // immediately on the main side and are NOT pumped through the
  // settings `dirty` flag. Each handler:
  //
  //   1. Sets `providerAuthBusyId` to disable the row's buttons
  //   2. Calls the relevant `desktop.*` IPC method
  //   3. On success, updates `providerAuthRows` via the canonical
  //      `desktop.listProviderAuths()` re-fetch (refresh / delete) or
  //      appends the returned row (import). The re-fetch keeps the
  //      list authoritative — main updates `lastQuotaAt`,
  //      `lastErrorCode`, etc. as a side-effect of `refreshProviderQuota`,
  //      and the renderer mirrors that without trying to derive it
  //      from the `QuotaStatus` envelope.
  //   4. On failure, parks the redacted error code + message in
  //      `providerAuthError` for display (≤80 chars per main-side
  //      schema, requirements §10.4) and leaves the existing rows
  //      intact.
  //   5. Always clears `providerAuthBusyId` in `finally`.

  const handleProviderAuthImport = useCallback(async () => {
    const desktop = window.desktop;
    if (!desktop) return;
    setProviderAuthBusyId('__import__');
    setProviderAuthError(null);
    try {
      const row = await desktop.importProviderAuthFile({
        provider: providerPick,
      });
      setProviderAuthRows((prev) => {
        // Replace if main returned a row whose id collides with an
        // existing one (re-import overwrites; design.md §Storage
        // Layout); otherwise append.
        const idx = prev.findIndex((r) => r.id === row.id);
        if (idx === -1) return [...prev, row];
        const next = prev.slice();
        next[idx] = row;
        return next;
      });
    } catch (err: unknown) {
      const envelope = extractIpcError(err, t);
      // `cancelled` is a normal user gesture (Requirement 8.3) —
      // do not surface it as an error.
      if (envelope.code !== 'cancelled') {
        setProviderAuthError(envelope);
      }
    } finally {
      setProviderAuthBusyId(null);
    }
  }, [providerPick, t]);

  const handleProviderAuthRefresh = useCallback(async (id: string) => {
    const desktop = window.desktop;
    if (!desktop) return;
    setProviderAuthBusyId(id);
    setProviderAuthError(null);
    try {
      await desktop.refreshProviderQuota({ id });
      // Re-fetch the metadata list — main has updated
      // `lastQuotaAt` / `lastErrorCode` / `lastErrorMessage` on the
      // row as a side-effect of the refresh. The `QuotaStatus`
      // envelope itself only carries `QuotaSnapshot[]`, not the
      // metadata projection the list renders from.
      const rows = await desktop.listProviderAuths();
      setProviderAuthRows(rows);
    } catch (err: unknown) {
      setProviderAuthError(extractIpcError(err, t));
    } finally {
      setProviderAuthBusyId(null);
    }
  }, [t]);

  const handleProviderAuthDelete = useCallback(async (id: string) => {
    const desktop = window.desktop;
    if (!desktop) return;
    setProviderAuthBusyId(id);
    setProviderAuthError(null);
    try {
      await desktop.deleteProviderAuth({ id });
      setProviderAuthRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err: unknown) {
      setProviderAuthError(extractIpcError(err, t));
    } finally {
      setProviderAuthBusyId(null);
    }
  }, [t]);

  /**
   * Submit the manual API-key form. Mirrors the import handler:
   * busy sentinel, error parking, list mutation on success.
   * Validation that the renderer can do up front (empty key,
   * missing baseUrl for openai-compatible) happens before the IPC
   * call so the user gets a faster failure; the main-side schema
   * does the same checks for defence in depth.
   */
  const handleProviderAuthCreateApiKey = useCallback(async () => {
    const desktop = window.desktop;
    if (!desktop) return;

    // Xiaomi MiMo uses a cookie-pair (passToken + userId) instead of
    // a single API key string; everyone else uses the standard
    // `apiKey` (+ optional baseUrl for openai-compatible).
    if (apiKeyProvider === 'xiaomi') {
      const trimmedPassToken = xiaomiPassToken.trim();
      const trimmedUserId = xiaomiUserId.trim();
      if (trimmedPassToken.length === 0 || trimmedUserId.length === 0) {
        setProviderAuthError({
          code: 'validation',
          message: t('settings.accounts.apiKey.validation.xiaomiRequired'),
        });
        return;
      }
      setProviderAuthBusyId('__create__');
      setProviderAuthError(null);
      try {
        const input: CreateProviderAuthApiKeyInput = {
          provider: 'xiaomi',
          xiaomiPassToken: trimmedPassToken,
          xiaomiUserId: trimmedUserId,
        };
        if (apiKeyLabel.trim().length > 0) input.label = apiKeyLabel.trim();
        const row = await desktop.createProviderAuthApiKey(input);
        setProviderAuthRows((prev) => {
          const idx = prev.findIndex((r) => r.id === row.id);
          if (idx === -1) return [...prev, row];
          const next = prev.slice();
          next[idx] = row;
          return next;
        });
        setApiKeyLabel('');
        setXiaomiPassToken('');
        setXiaomiUserId('');
        setXiaomiPassTokenShow(false);
        setApiKeyFormOpen(false);
      } catch (err: unknown) {
        setProviderAuthError(extractIpcError(err, t));
      } finally {
        setProviderAuthBusyId(null);
      }
      return;
    }

    // OpenCode Go uses an opaque `auth` cookie + workspace URL
    // (no API key). The cookie is Iron-encrypted on the server
    // side; we treat it as an opaque blob and forward verbatim.
    if (apiKeyProvider === 'opencode') {
      const trimmedAuth = opencodeAuthCookie.trim();
      const trimmedUrl = opencodeWorkspaceUrl.trim();
      if (trimmedAuth.length === 0 || trimmedUrl.length === 0) {
        setProviderAuthError({
          code: 'validation',
          message: t('settings.accounts.apiKey.validation.opencodeRequired'),
        });
        return;
      }
      setProviderAuthBusyId('__create__');
      setProviderAuthError(null);
      try {
        const input: CreateProviderAuthApiKeyInput = {
          provider: 'opencode',
          opencodeAuthCookie: trimmedAuth,
          opencodeWorkspaceUrl: trimmedUrl,
        };
        if (apiKeyLabel.trim().length > 0) input.label = apiKeyLabel.trim();
        const row = await desktop.createProviderAuthApiKey(input);
        setProviderAuthRows((prev) => {
          const idx = prev.findIndex((r) => r.id === row.id);
          if (idx === -1) return [...prev, row];
          const next = prev.slice();
          next[idx] = row;
          return next;
        });
        setApiKeyLabel('');
        setOpencodeAuthCookie('');
        setOpencodeWorkspaceUrl('');
        setOpencodeAuthCookieShow(false);
        setApiKeyFormOpen(false);
      } catch (err: unknown) {
        setProviderAuthError(extractIpcError(err, t));
      } finally {
        setProviderAuthBusyId(null);
      }
      return;
    }

    const trimmedKey = apiKeyValue.trim();
    if (trimmedKey.length === 0) {
      setProviderAuthError({
        code: 'validation',
        message: t('settings.accounts.apiKey.validation.empty'),
      });
      return;
    }
    if (
      apiKeyProvider === 'openai-compatible' &&
      apiKeyBaseUrl.trim().length === 0
    ) {
      setProviderAuthError({
        code: 'validation',
        message: t('settings.accounts.apiKey.validation.baseUrlRequired'),
      });
      return;
    }
    setProviderAuthBusyId('__create__');
    setProviderAuthError(null);
    try {
      const input: CreateProviderAuthApiKeyInput = {
        provider: apiKeyProvider,
        apiKey: trimmedKey,
      };
      if (apiKeyLabel.trim().length > 0) input.label = apiKeyLabel.trim();
      const trimmedBase = apiKeyBaseUrl.trim();
      if (trimmedBase.length > 0) input.baseUrl = trimmedBase;
      if (apiKeyProvider === 'deepseek') {
        const trimmedUserToken = deepseekUserToken.trim();
        if (trimmedUserToken.length > 0) {
          input.deepseekUserToken = trimmedUserToken;
        }
      }
      const row = await desktop.createProviderAuthApiKey(input);
      setProviderAuthRows((prev) => {
        const idx = prev.findIndex((r) => r.id === row.id);
        if (idx === -1) return [...prev, row];
        const next = prev.slice();
        next[idx] = row;
        return next;
      });
      // Reset the form on success so the user can add another
      // account without re-opening the form.
      setApiKeyValue('');
      setApiKeyLabel('');
      setApiKeyBaseUrl('');
      setApiKeyShow(false);
      setDeepseekUserToken('');
      setDeepseekUserTokenShow(false);
      setApiKeyFormOpen(false);
    } catch (err: unknown) {
      setProviderAuthError(extractIpcError(err, t));
    } finally {
      setProviderAuthBusyId(null);
    }
  }, [
    apiKeyProvider,
    apiKeyLabel,
    apiKeyValue,
    apiKeyBaseUrl,
    xiaomiPassToken,
    xiaomiUserId,
    deepseekUserToken,
    opencodeAuthCookie,
    opencodeWorkspaceUrl,
    t,
  ]);

  // ---------------------------------------------------------------------------
  // Provider_Auth edit handlers
  // ---------------------------------------------------------------------------

  /** Clear all secret inputs and edit state. Called on cancel or after success. */
  const clearEditState = useCallback(() => {
    setEditingProviderAuthId(null);
    setEditingMode(null);
    setApiKeyValue('');
    setApiKeyLabel('');
    setApiKeyBaseUrl('');
    setApiKeyShow(false);
    setXiaomiPassToken('');
    setXiaomiUserId('');
    setXiaomiPassTokenShow(false);
    setDeepseekUserToken('');
    setDeepseekUserTokenShow(false);
    setOpencodeAuthCookie('');
    setOpencodeWorkspaceUrl('');
    setOpencodeAuthCookieShow(false);
  }, []);

  /** Open the edit panel for an existing account. */
  const handleProviderAuthEdit = useCallback(
    (row: ProviderAuthMetadata) => {
      clearEditState();
      setEditingProviderAuthId(row.id);
      setApiKeyLabel(row.label);
      // Set the provider selector to the row's provider so the form
      // shows the correct fields. For manual accounts, the provider
      // selector will be disabled.
      if (
        row.provider === 'gemini-api' ||
        row.provider === 'deepseek' ||
        row.provider === 'xiaomi' ||
        row.provider === 'opencode' ||
        row.provider === 'openai-compatible'
      ) {
        setApiKeyProvider(row.provider as ManualApiKeyProvider);
      }
      if (row.source === 'manual-api-key') {
        setEditingMode('manual');
        setApiKeyFormOpen(true);
      } else {
        setEditingMode('reimport');
      }
    },
    [clearEditState],
  );

  /** Cancel editing and close the form. */
  const handleProviderAuthEditCancel = useCallback(() => {
    clearEditState();
    setApiKeyFormOpen(false);
  }, [clearEditState]);

  /** Submit an in-place update for a manual-api-key account. */
  const handleProviderAuthUpdate = useCallback(async () => {
    const desktop = window.desktop;
    if (!desktop || editingProviderAuthId === null) return;

    const input: import('../../main/types').UpdateProviderAuthInput = {
      id: editingProviderAuthId,
    };
    if (apiKeyLabel.trim().length > 0) input.label = apiKeyLabel.trim();

    // Only include non-empty secret fields (empty = keep existing).
    if (apiKeyProvider === 'xiaomi') {
      if (xiaomiPassToken.trim().length > 0) input.xiaomiPassToken = xiaomiPassToken.trim();
      if (xiaomiUserId.trim().length > 0) input.xiaomiUserId = xiaomiUserId.trim();
    } else if (apiKeyProvider === 'opencode') {
      if (opencodeAuthCookie.trim().length > 0) input.opencodeAuthCookie = opencodeAuthCookie.trim();
      if (opencodeWorkspaceUrl.trim().length > 0) input.opencodeWorkspaceUrl = opencodeWorkspaceUrl.trim();
    } else {
      if (apiKeyValue.trim().length > 0) input.apiKey = apiKeyValue.trim();
      if (apiKeyProvider === 'openai-compatible' && apiKeyBaseUrl.trim().length > 0) {
        input.baseUrl = apiKeyBaseUrl.trim();
      }
      if (apiKeyProvider === 'deepseek' && deepseekUserToken.trim().length > 0) {
        input.deepseekUserToken = deepseekUserToken.trim();
      }
    }

    setProviderAuthBusyId(editingProviderAuthId);
    setProviderAuthError(null);
    try {
      const row = await desktop.updateProviderAuth(input);
      if (row !== null) {
        setProviderAuthRows((prev) => {
          const idx = prev.findIndex((r) => r.id === row.id);
          if (idx === -1) return [...prev, row];
          const next = prev.slice();
          next[idx] = row;
          return next;
        });
      }
      clearEditState();
      setApiKeyFormOpen(false);
    } catch (err: unknown) {
      setProviderAuthError(extractIpcError(err, t));
    } finally {
      setProviderAuthBusyId(null);
    }
  }, [
    editingProviderAuthId,
    apiKeyProvider,
    apiKeyLabel,
    apiKeyValue,
    apiKeyBaseUrl,
    xiaomiPassToken,
    xiaomiUserId,
    deepseekUserToken,
    opencodeAuthCookie,
    opencodeWorkspaceUrl,
    clearEditState,
    t,
  ]);

  /** Re-import the CPA auth file for an existing cpa-auth-file account. */
  const handleProviderAuthReimport = useCallback(
    async (id: string) => {
      const desktop = window.desktop;
      if (!desktop) return;
      setProviderAuthBusyId(id);
      setProviderAuthError(null);
      try {
        const input: import('../../main/types').ReimportProviderAuthFileInput = { id };
        if (apiKeyLabel.trim().length > 0) input.label = apiKeyLabel.trim();
        const row = await desktop.reimportProviderAuthFile(input);
        if (row !== null) {
          setProviderAuthRows((prev) => {
            const idx = prev.findIndex((r) => r.id === row.id);
            if (idx === -1) return [...prev, row];
            const next = prev.slice();
            next[idx] = row;
            return next;
          });
        }
        clearEditState();
      } catch (err: unknown) {
        const envelope = extractIpcError(err, t);
        if (envelope.code !== 'cancelled') {
          setProviderAuthError(envelope);
        }
      } finally {
        setProviderAuthBusyId(null);
      }
    },
    [apiKeyLabel, clearEditState, t],
  );

  // ---------------------------------------------------------------------------
  // Save / discard handlers
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!settings) return;
    const desktop = window.desktop;
    if (!desktop) return;

    const validationErrors = validateSettings(settings, t);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const updated = await desktop.updateSettings(settings);
      setSettings(updated);
      setPristine(updated);

      if (secret.trim()) {
        await desktop.updateSecret({
          key: 'openclash.controllerSecret',
          value: secret.trim(),
        });
        setSecret('');
      }

      // LuCI management credentials follow the same write-only
      // pattern as the controller secret: the renderer never reads
      // existing values, only writes a non-empty replacement.
      // Each key is sent independently so the user can update one
      // without re-entering the other.
      if (luciUsername.length > 0) {
        await desktop.updateSecret({
          key: 'openclash.management.username',
          value: luciUsername,
        });
        setLuciUsername('');
      }
      if (luciPassword.length > 0) {
        await desktop.updateSecret({
          key: 'openclash.management.password',
          value: luciPassword,
        });
        setLuciPassword('');
      }
      // A successful save invalidates the "凭据已清除" hint — the
      // user has either re-entered creds or saved settings around
      // them, and the indicator should not linger.
      setCredsCleared(false);

      setSaveSuccess(true);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('settings.action.unknownError');
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [settings, secret, luciUsername, luciPassword, t]);

  const handleDiscard = useCallback(() => {
    if (!pristine) return;
    setSettings(pristine);
    setSecret('');
    setLuciUsername('');
    setLuciPassword('');
    setErrors({});
    setSaveError(null);
    setSaveSuccess(false);
  }, [pristine]);

  // Smooth-scroll to a section when the rail is clicked.
  const handleNavClick = useCallback((id: string) => {
    const target = document.getElementById(`settings-section-${id}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="settings-view" role="main" aria-label={t('settings.aria.root')}>
        <p className="settings-view__loading">{t('boot.loadingSettings')}</p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="settings-view" role="main" aria-label={t('settings.aria.root')}>
        <p className="settings-view__error">{t('boot.cannotLoadSettings')}</p>
      </div>
    );
  }

  return (
    <div className="settings-view" role="main" aria-label={t('settings.aria.root')}>
      <header className="settings-view__header">
        <div>
          <span className="settings-view__eyebrow">configuration</span>
          <h2 className="settings-view__title">设置</h2>
        </div>
        <p className="settings-view__subtitle">
          调整 OpenClash 控制器、网络探测与 AI 采集器的行为。改动会在保存后立即生效。
        </p>
      </header>

      <div className="settings-view__layout">
        {/* Section rail */}
        <nav className="settings-view__rail" aria-label={t('settings.aria.nav')}>
          <ul className="settings-view__rail-list">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="settings-view__rail-item"
                  onClick={() => handleNavClick(s.id)}
                >
                  <span className="settings-view__rail-icon" aria-hidden="true">
                    {s.icon}
                  </span>
                  <span className="settings-view__rail-text">
                    <span className="settings-view__rail-label">
                      {t(`settings.section.${s.i18nKey}.label` as TranslationKey)}
                    </span>
                    <span className="settings-view__rail-hint">
                      {t(`settings.section.${s.i18nKey}.hint` as TranslationKey)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Form body */}
        <form
          className="settings-view__form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          noValidate
        >
          {/* ── Appearance ───────────────────────────────────── */}
          <Section id="appearance" section={SECTIONS[0]!}>
            {/*
              Locale picker (i18n-multilingual-support, Requirements 8.1, 8.2,
              8.3, 8.4).

              Placed at the top of the `appearance` section so it is reachable
              without horizontal scrolling at the 800 px minimum viewport (the
              `settings-view__form` grid collapses to a single column at that
              width).

              The two option labels are written inline as native-script literals
              and intentionally NOT routed through `t()`: a user accidentally
              locked into the wrong language must still recognise the option to
              switch back (Requirement 8.2).

              The `value` prop is wired to `settings.locale` from the
              `desktop.getSettings()` load above, so the persisted Locale_Setting
              is reflected on mount within one render after settings resolve
              (Requirement 8.3 — well under the 500 ms budget). Main-side
              `normalizeAppSettings` guarantees the persisted value is always a
              member of the closed Locale_Code set; the narrowing below is a
              defensive belt for the absent / null / out-of-set case
              (Requirement 8.4) so a corrupted row falls back to the
              Default_Locale `'zh-CN'` rather than rendering nothing selected.

              `onChange` is wired to {@link handleLocaleChange}, an
              eager-commit handler that mirrors `handleClearManagement
              Credentials`: it optimistically updates local state, then
              dispatches `desktop.updateSettings({ locale })` synchronously
              in the user-event handler. No separate Save click is
              required (Requirement 8.5). Failures are surfaced via the
              `localeError` state below the picker without touching the
              form's `dirty` flag (Requirements 8.6, 8.7).
            */}
            <Field
              label={t('settings.locale.label')}
              hint={t('settings.locale.hint')}
              error={localeError ?? undefined}
            >
              <SegmentedControl<Locale_Code>
                value={
                  settings.locale === 'zh-CN' || settings.locale === 'en-US'
                    ? settings.locale
                    : 'zh-CN'
                }
                options={[
                  { value: 'zh-CN', label: '中文（简体）' },
                  { value: 'en-US', label: 'English' },
                ]}
                onChange={(next) => {
                  void handleLocaleChange(next);
                }}
                ariaLabel={t('settings.locale.label')}
              />
            </Field>

            <Field
              label={t('settings.appearance.colorMode.label')}
              hint={t('settings.appearance.colorMode.hint')}
            >
              <SegmentedControl<ColorMode>
                value={(settings.appearance ?? DEFAULT_APPEARANCE).colorMode}
                options={[
                  { value: 'dark', label: t('settings.appearance.colorMode.dark') },
                  { value: 'light', label: t('settings.appearance.colorMode.light') },
                ]}
                onChange={(v) => updateAppearance({ colorMode: v })}
                ariaLabel={t('settings.appearance.colorMode.aria')}
              />
            </Field>

            <Field
              label={t('settings.appearance.fontScale.label')}
              hint={t('settings.appearance.fontScale.hint')}
            >
              <div className="settings-view__range-control">
                <input
                  className="settings-view__range"
                  type="range"
                  min={0.9}
                  max={1.2}
                  step={0.05}
                  value={(settings.appearance ?? DEFAULT_APPEARANCE).fontScale}
                  onChange={(e) =>
                    updateAppearance({ fontScale: Number(e.target.value) })
                  }
                  aria-label={t('settings.appearance.fontScale.aria')}
                />
                <span className="settings-view__range-value">
                  {Math.round(
                    (settings.appearance ?? DEFAULT_APPEARANCE).fontScale *
                      100,
                  )}
                  %
                </span>
              </div>
            </Field>

            <Field
              label={t('settings.appearance.compactZoom.label')}
              hint={t('settings.appearance.compactZoom.hint')}
            >
              <div className="settings-view__range-control">
                <input
                  className="settings-view__range"
                  type="range"
                  min={1}
                  max={2}
                  step={0.1}
                  value={(settings.appearance ?? DEFAULT_APPEARANCE).compactZoom}
                  onChange={(e) =>
                    updateAppearance({ compactZoom: Number(e.target.value) })
                  }
                  aria-label={t('settings.appearance.compactZoom.aria')}
                />
                <span className="settings-view__range-value">
                  {Math.round(
                    (settings.appearance ?? DEFAULT_APPEARANCE).compactZoom *
                      100,
                  )}
                  %
                </span>
              </div>
            </Field>

            <div className="settings-view__theme-grid">
              {COMPACT_THEME_OPTIONS.map((opt) => {
                const active =
                  (settings.appearance ?? DEFAULT_APPEARANCE).compactTheme ===
                  opt.id;
                const themeLabel = t(
                  `settings.appearance.theme.${opt.i18nKey}.label` as TranslationKey,
                );
                const themeDesc = t(
                  `settings.appearance.theme.${opt.i18nKey}.description` as TranslationKey,
                );
                return (
                  <button
                    type="button"
                    key={opt.id}
                    className={`settings-view__theme-card${
                      active ? ' settings-view__theme-card--active' : ''
                    }`}
                    onClick={() => updateAppearance({ compactTheme: opt.id })}
                    aria-pressed={active}
                    aria-label={t('settings.appearance.theme.cardAria', {
                      name: themeLabel,
                    })}
                  >
                    <span
                      className="settings-view__theme-preview"
                      data-compact-theme={opt.id}
                      aria-hidden="true"
                    >
                      <span className="settings-view__theme-preview-fx" />
                      <span className="settings-view__theme-preview-bar" />
                      <span className="settings-view__theme-preview-bar settings-view__theme-preview-bar--short" />
                    </span>
                    <span className="settings-view__theme-meta">
                      <span className="settings-view__theme-name">
                        {themeLabel}
                        {active && (
                          <Check
                            size={12}
                            strokeWidth={2.4}
                            className="settings-view__theme-check"
                          />
                        )}
                      </span>
                      <span className="settings-view__theme-desc">
                        {themeDesc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* ── Controller ───────────────────────────────────── */}
          <Section
            id="controller"
            section={SECTIONS[1]!}
          >
            <div className="settings-view__row">
              <Field
                label={t('settings.controller.url.label')}
                hint={t('settings.controller.url.hint')}
                error={errors.controllerUrl}
              >
                <input
                  className="settings-view__input"
                  type="url"
                  value={settings.controllerUrl}
                  onChange={(e) => updateField('controllerUrl', e.target.value)}
                  aria-invalid={!!errors.controllerUrl}
                  placeholder={t('settings.controller.url.placeholder')}
                />
              </Field>

              <Field
                label={t('settings.controller.secret.label')}
                hint={t('settings.controller.secret.hint')}
              >
                <div className="settings-view__input-affix">
                  <input
                    className="settings-view__input"
                    type={showSecret ? 'text' : 'password'}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={t('settings.controller.secret.placeholder')}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="settings-view__input-action"
                    onClick={() => setShowSecret((v) => !v)}
                    aria-label={
                      showSecret
                        ? t('settings.controller.secret.hideAria')
                        : t('settings.controller.secret.showAria')
                    }
                  >
                    {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </Field>
            </div>
          </Section>

          {/* ── Probe URLs ───────────────────────────────────── */}
          <Section id="probes" section={SECTIONS[2]!}>
            <ListField
              items={settings.probeUrls}
              placeholder={t('settings.probes.placeholder')}
              addLabel={t('settings.probes.addLabel')}
              type="url"
              variant="single"
              onUpdate={updateProbeUrl}
              onAdd={addProbeUrl}
              onRemove={removeProbeUrl}
              ariaLabel={t('settings.probes.itemAria')}
            />
            {errors.probeUrls && (
              <p className="settings-view__error-msg" role="alert">
                {errors.probeUrls}
              </p>
            )}
          </Section>

          {/* ── Primary Groups ───────────────────────────────── */}
          <Section id="groups" section={SECTIONS[3]!}>
            <ListField
              items={settings.primaryGroups}
              placeholder={t('settings.groups.placeholder')}
              addLabel={t('settings.groups.addLabel')}
              type="text"
              onUpdate={updatePrimaryGroup}
              onAdd={addPrimaryGroup}
              onRemove={removePrimaryGroup}
              ariaLabel={t('settings.groups.itemAria')}
            />
          </Section>

          {/* ── Router Health ────────────────────────────────── */}
          <Section id="router" section={SECTIONS[4]!}>
            <div className="settings-view__row settings-view__row--router">
              <Field
                label={t('settings.router.host.label')}
                hint={t('settings.router.host.hint')}
              >
                <input
                  className="settings-view__input"
                  type="text"
                  value={settings.routerHealth.host}
                  onChange={(e) =>
                    updateField('routerHealth', {
                      ...settings.routerHealth,
                      host: e.target.value,
                    })
                  }
                  placeholder={t('settings.router.host.placeholder')}
                />
              </Field>
              <Field
                label={t('settings.router.port.label')}
                hint={t('settings.router.port.hint')}
                error={errors.routerHealthPort}
              >
                <input
                  className="settings-view__input"
                  type="number"
                  min={1}
                  max={65535}
                  value={settings.routerHealth.port}
                  onChange={(e) =>
                    updateField('routerHealth', {
                      ...settings.routerHealth,
                      port: Number(e.target.value),
                    })
                  }
                  aria-invalid={!!errors.routerHealthPort}
                />
              </Field>
            </div>
          </Section>

          {/* ── Refresh intervals ────────────────────────────── */}
          <Section id="intervals" section={SECTIONS[5]!}>
            <div className="settings-view__grid">
              {(Object.entries(settings.refreshIntervals) as [
                keyof RefreshIntervalSettings,
                number,
              ][]).map(([key, value]) => {
                const meta = INTERVAL_META[key];
                const intervalLabel = t(
                  `settings.intervals.${meta.i18nKey}.label` as TranslationKey,
                );
                const intervalHint = t(
                  `settings.intervals.${meta.i18nKey}.hint` as TranslationKey,
                );
                return (
                  <Field key={key} label={intervalLabel} hint={intervalHint}>
                    <div className="settings-view__input-affix settings-view__input-affix--suffix">
                      <input
                        className="settings-view__input settings-view__input--num"
                        type="number"
                        min={1000}
                        step={500}
                        value={value}
                        onChange={(e) => updateInterval(key, Number(e.target.value))}
                      />
                      <span className="settings-view__input-suffix">ms</span>
                    </div>
                  </Field>
                );
              })}
            </div>
            {errors.refreshIntervals && (
              <p className="settings-view__error-msg" role="alert">
                {errors.refreshIntervals}
              </p>
            )}
          </Section>

          {/* ── Switch settings ──────────────────────────────── */}
          <Section id="switching" section={SECTIONS[6]!}>
            <div className="settings-view__row">
              <Field
                label={t('settings.switching.verifyDelay.label')}
                hint={t('settings.switching.verifyDelay.hint')}
                error={errors.switchVerifyDelayMs}
              >
                <div className="settings-view__input-affix settings-view__input-affix--suffix">
                  <input
                    className="settings-view__input settings-view__input--num"
                    type="number"
                    min={0}
                    max={10000}
                    step={100}
                    value={settings.switchVerifyDelayMs}
                    onChange={(e) =>
                      updateField('switchVerifyDelayMs', Number(e.target.value))
                    }
                    aria-invalid={!!errors.switchVerifyDelayMs}
                  />
                  <span className="settings-view__input-suffix">ms</span>
                </div>
              </Field>

              <ToggleField
                label={t('settings.switching.confirm.label')}
                hint={t('settings.switching.confirm.hint')}
                checked={settings.switchConfirmation}
                onChange={(v) => updateField('switchConfirmation', v)}
              />
            </div>
          </Section>

          {/* ── OpenClash 管理接口 ───────────────────────────── */}
          <Section id="management" section={SECTIONS[7]!}>
            <div className="settings-view__row">
              <Field
                label={t('settings.management.url.label')}
                hint={t('settings.management.url.hint')}
                error={errors.managementUrl}
              >
                <input
                  className="settings-view__input"
                  type="url"
                  value={settings.managementInterface.url}
                  onChange={(e) => updateManagementUrl(e.target.value)}
                  aria-invalid={!!errors.managementUrl}
                  placeholder={t('settings.management.url.placeholder')}
                />
              </Field>

              <Field
                label={t('settings.management.requestTimeout.label')}
                hint={t('settings.management.requestTimeout.hint')}
                error={errors.managementRequestTimeoutMs}
              >
                <div className="settings-view__input-affix settings-view__input-affix--suffix">
                  <input
                    className="settings-view__input settings-view__input--num"
                    type="number"
                    min={1000}
                    max={30000}
                    step={500}
                    value={settings.managementInterface.requestTimeoutMs}
                    onChange={(e) =>
                      updateManagementRequestTimeout(Number(e.target.value))
                    }
                    aria-invalid={!!errors.managementRequestTimeoutMs}
                  />
                  <span className="settings-view__input-suffix">ms</span>
                </div>
              </Field>
            </div>

            <div className="settings-view__row">
              <Field
                label={t('settings.management.verifyWindow.label')}
                hint={t('settings.management.verifyWindow.hint')}
                error={errors.configSwitchVerifyWindowMs}
              >
                <div className="settings-view__input-affix settings-view__input-affix--suffix">
                  <input
                    className="settings-view__input settings-view__input--num"
                    type="number"
                    min={1000}
                    max={30000}
                    step={500}
                    value={settings.configSwitchVerifyWindowMs}
                    onChange={(e) =>
                      updateConfigSwitchVerifyWindow(Number(e.target.value))
                    }
                    aria-invalid={!!errors.configSwitchVerifyWindowMs}
                  />
                  <span className="settings-view__input-suffix">ms</span>
                </div>
              </Field>
            </div>

            {/* LuCI credentials. Write-only: the renderer never sees
                existing values; an empty input means "leave the
                stored credential unchanged on save". */}
            <div className="settings-view__row">
              <Field
                label={t('settings.management.username.label')}
                hint={t('settings.management.username.hint')}
              >
                <input
                  className="settings-view__input"
                  type="text"
                  value={luciUsername}
                  onChange={(e) => {
                    setLuciUsername(e.target.value);
                    setSaveSuccess(false);
                    setCredsCleared(false);
                  }}
                  placeholder={t('settings.management.username.placeholder')}
                  autoComplete="off"
                />
              </Field>

              <Field
                label={t('settings.management.password.label')}
                hint={t('settings.management.password.hint')}
              >
                <div className="settings-view__input-affix">
                  <input
                    className="settings-view__input"
                    type={showLuciPassword ? 'text' : 'password'}
                    value={luciPassword}
                    onChange={(e) => {
                      setLuciPassword(e.target.value);
                      setSaveSuccess(false);
                      setCredsCleared(false);
                    }}
                    placeholder={t('settings.management.password.placeholder')}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="settings-view__input-action"
                    onClick={() => setShowLuciPassword((v) => !v)}
                    aria-label={
                      showLuciPassword
                        ? t('settings.management.password.hideAria')
                        : t('settings.management.password.showAria')
                    }
                  >
                    {showLuciPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </Field>
            </div>

            <div className="settings-view__management-actions">
              <button
                type="button"
                className="settings-view__btn-secondary"
                onClick={() => void handleClearManagementCredentials()}
              >
                {t('settings.management.clearCredentials')}
              </button>
              {credsCleared && (
                <span
                  className="settings-view__management-cleared"
                  role="status"
                >
                  <Check size={12} strokeWidth={2} />
                  {t('settings.management.credentialsCleared')}
                </span>
              )}
            </div>

            {/* Whitelist editor — alias + path rows. The renderer
                surfaces the alias to users (Requirement 4.4); the
                path is sent verbatim to the management interface
                and validated against `CONFIG_PATH_RE`. */}
            <div className="settings-view__whitelist">
              <header className="settings-view__whitelist-head">
                <span className="settings-view__label">
                  {t('settings.management.whitelist.label')}
                </span>
                <span className="settings-view__hint">
                  {t('settings.management.whitelist.hint')}
                </span>
              </header>
              {settings.managementInterface.configFileWhitelist.length === 0 && (
                <p className="settings-view__empty">
                  {t('settings.management.whitelist.empty')}
                </p>
              )}
              {settings.managementInterface.configFileWhitelist.map(
                (entry, i) => (
                  <div className="settings-view__whitelist-row" key={i}>
                    <span className="settings-view__list-index">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <input
                      className="settings-view__input"
                      type="text"
                      value={entry.alias}
                      onChange={(e) =>
                        updateWhitelistEntry(i, { alias: e.target.value })
                      }
                      placeholder={t(
                        'settings.management.whitelist.aliasPlaceholder',
                      )}
                      aria-label={t(
                        'settings.management.whitelist.aliasAria',
                        { n: i + 1 },
                      )}
                    />
                    <input
                      className="settings-view__input"
                      type="text"
                      value={entry.path}
                      onChange={(e) =>
                        updateWhitelistEntry(i, { path: e.target.value })
                      }
                      placeholder={t(
                        'settings.management.whitelist.pathPlaceholder',
                      )}
                      aria-label={t(
                        'settings.management.whitelist.pathAria',
                        { n: i + 1 },
                      )}
                    />
                    <button
                      type="button"
                      className="settings-view__btn-icon"
                      onClick={() => removeWhitelistEntry(i)}
                      aria-label={t(
                        'settings.management.whitelist.deleteAria',
                        { n: i + 1 },
                      )}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                ),
              )}
              <button
                type="button"
                className="settings-view__btn-add"
                onClick={addWhitelistEntry}
              >
                <Plus size={14} strokeWidth={2} />
                <span>{t('settings.management.whitelist.addLabel')}</span>
              </button>
              {errors.configFileWhitelist && (
                <p className="settings-view__error-msg" role="alert">
                  {errors.configFileWhitelist}
                </p>
              )}
            </div>
          </Section>

          {/* ── AI 账号 ─────────────────────────────────────── */}
          <Section id="accounts" section={SECTIONS[8]!}>
            <div className="settings-view__row">
              <Field
                label={t('settings.accounts.providerType.label')}
                hint={t('settings.accounts.providerType.hint')}
              >
                <select
                  className="settings-view__input"
                  value={providerPick}
                  onChange={(e) =>
                    setProviderPick(e.target.value as ProviderId)
                  }
                  aria-label={t('settings.accounts.providerType.aria')}
                  disabled={providerAuthBusyId === '__import__'}
                >
                  {FILE_IMPORT_PICKER_ORDER.map((id) => (
                    <option key={id} value={id}>
                      {PROVIDER_LABELS[id]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label={t('settings.accounts.actions.label')}
                hint={t('settings.accounts.actions.hint')}
              >
                <div className="settings-view__row settings-view__row--inline">
                  <button
                    type="button"
                    className="settings-view__btn-secondary"
                    onClick={() => void handleProviderAuthImport()}
                    disabled={providerAuthBusyId === '__import__'}
                    data-testid="provider-auth-import"
                  >
                    <Plus size={13} strokeWidth={2} aria-hidden="true" />
                    {providerAuthBusyId === '__import__'
                      ? t('settings.accounts.import.busy')
                      : t('settings.accounts.import.label')}
                  </button>
                  <button
                    type="button"
                    className="settings-view__btn-secondary"
                    onClick={() => {
                      setApiKeyFormOpen((v) => !v);
                      setProviderAuthError(null);
                    }}
                    disabled={providerAuthBusyId !== null}
                    data-testid="provider-auth-open-api-key-form"
                    aria-expanded={apiKeyFormOpen}
                  >
                    <KeyRound size={13} strokeWidth={2} aria-hidden="true" />
                    {apiKeyFormOpen
                      ? t('settings.accounts.apiKey.closeForm')
                      : t('settings.accounts.apiKey.openForm')}
                  </button>
                </div>
              </Field>
            </div>

            {apiKeyFormOpen && editingProviderAuthId === null && (
              <div
                className="settings-view__api-key-form"
                data-testid="provider-auth-api-key-form"
              >
                <div className="settings-view__row">
                  <Field
                    label={t('settings.accounts.apiKey.providerLabel')}
                    hint={t('settings.accounts.apiKey.providerHint')}
                  >
                    <select
                      className="settings-view__input"
                      value={apiKeyProvider}
                      onChange={(e) =>
                        setApiKeyProvider(
                          e.target.value as ManualApiKeyProvider,
                        )
                      }
                      aria-label={t('settings.accounts.apiKey.providerAria')}
                      disabled={providerAuthBusyId !== null || editingProviderAuthId !== null}
                      data-testid="provider-auth-api-key-provider"
                    >
                      {MANUAL_API_KEY_PICKER_ORDER.map((id) => (
                        <option key={id} value={id}>
                          {PROVIDER_LABELS[id]}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field
                    label={t('settings.accounts.apiKey.displayName.label')}
                    hint={t('settings.accounts.apiKey.displayName.hint')}
                  >
                    <input
                      className="settings-view__input"
                      type="text"
                      value={apiKeyLabel}
                      onChange={(e) => setApiKeyLabel(e.target.value)}
                      placeholder={t(
                        'settings.accounts.apiKey.displayName.placeholder',
                      )}
                      autoComplete="off"
                      disabled={providerAuthBusyId !== null}
                      data-testid="provider-auth-api-key-label"
                    />
                  </Field>
                </div>

                <div className="settings-view__row">
                  {apiKeyProvider === 'xiaomi' ? (
                    <>
                      <Field
                        label="passToken"
                        hint="从 account.xiaomi.com Cookie 复制；保存后即加密落库"
                      >
                        <div className="settings-view__input-affix">
                          <input
                            className="settings-view__input"
                            type={xiaomiPassTokenShow ? 'text' : 'password'}
                            value={xiaomiPassToken}
                            onChange={(e) =>
                              setXiaomiPassToken(e.target.value)
                            }
                            placeholder={
                              editingMode === 'manual'
                                ? t('settings.accounts.edit.secretPlaceholder')
                                : 'V1:...'
                            }
                            autoComplete="off"
                            disabled={providerAuthBusyId !== null}
                            data-testid="provider-auth-xiaomi-pass-token"
                          />
                          <button
                            type="button"
                            className="settings-view__input-action"
                            onClick={() =>
                              setXiaomiPassTokenShow((v) => !v)
                            }
                            aria-label={
                              xiaomiPassTokenShow
                                ? '隐藏 passToken'
                                : '显示 passToken'
                            }
                          >
                            {xiaomiPassTokenShow ? (
                              <EyeOff size={14} />
                            ) : (
                              <Eye size={14} />
                            )}
                          </button>
                        </div>
                      </Field>

                      <Field
                        label="userId"
                        hint="同一域下 Cookie 中的数字账号 id"
                      >
                        <input
                          className="settings-view__input"
                          type="text"
                          value={xiaomiUserId}
                          onChange={(e) => setXiaomiUserId(e.target.value)}
                          placeholder={
                            editingMode === 'manual'
                              ? t('settings.accounts.edit.secretPlaceholder')
                              : '例如 14800000'
                          }
                          autoComplete="off"
                          inputMode="numeric"
                          disabled={providerAuthBusyId !== null}
                          data-testid="provider-auth-xiaomi-user-id"
                        />
                      </Field>
                    </>
                  ) : apiKeyProvider === 'opencode' ? (
                    <>
                      <Field
                        label="auth Cookie"
                        hint="从 opencode.ai 域 Cookie 复制 `auth` 的值（Fe26.2 开头）；保存后即加密落库。session 会过期，过期后重新粘一次即可"
                      >
                        <div className="settings-view__input-affix">
                          <input
                            className="settings-view__input"
                            type={
                              opencodeAuthCookieShow ? 'text' : 'password'
                            }
                            value={opencodeAuthCookie}
                            onChange={(e) =>
                              setOpencodeAuthCookie(e.target.value)
                            }
                            placeholder={
                              editingMode === 'manual'
                                ? t('settings.accounts.edit.secretPlaceholder')
                                : 'Fe26.2**...'
                            }
                            autoComplete="off"
                            disabled={
                              providerAuthBusyId !== null
                            }
                            data-testid="provider-auth-opencode-auth-cookie"
                          />
                          <button
                            type="button"
                            className="settings-view__input-action"
                            onClick={() =>
                              setOpencodeAuthCookieShow((v) => !v)
                            }
                            aria-label={
                              opencodeAuthCookieShow
                                ? '隐藏 auth cookie'
                                : '显示 auth cookie'
                            }
                          >
                            {opencodeAuthCookieShow ? (
                              <EyeOff size={14} />
                            ) : (
                              <Eye size={14} />
                            )}
                          </button>
                        </div>
                      </Field>

                      <Field
                        label="Workspace URL"
                        hint="dashboard 完整 URL，例如 https://opencode.ai/workspace/wrk_xxx/go"
                      >
                        <input
                          className="settings-view__input"
                          type="url"
                          value={opencodeWorkspaceUrl}
                          onChange={(e) =>
                            setOpencodeWorkspaceUrl(e.target.value)
                          }
                          placeholder={
                            editingMode === 'manual'
                              ? t('settings.accounts.edit.secretPlaceholder')
                              : 'https://opencode.ai/workspace/.../go'
                          }
                          autoComplete="off"
                          disabled={providerAuthBusyId !== null}
                          data-testid="provider-auth-opencode-workspace-url"
                        />
                      </Field>
                    </>
                  ) : (
                    <>
                      <Field
                        label={t('settings.accounts.apiKey.value.label')}
                        hint={t('settings.accounts.apiKey.value.hint')}
                      >
                        <div className="settings-view__input-affix">
                          <input
                            className="settings-view__input"
                            type={apiKeyShow ? 'text' : 'password'}
                            value={apiKeyValue}
                            onChange={(e) => setApiKeyValue(e.target.value)}
                            placeholder={
                              editingMode === 'manual'
                                ? t('settings.accounts.edit.secretPlaceholder')
                                : t('settings.accounts.apiKey.value.placeholder')
                            }
                            autoComplete="off"
                            disabled={providerAuthBusyId !== null}
                            data-testid="provider-auth-api-key-value"
                          />
                          <button
                            type="button"
                            className="settings-view__input-action"
                            onClick={() => setApiKeyShow((v) => !v)}
                            aria-label={
                              apiKeyShow
                                ? t('settings.accounts.apiKey.value.hideAria')
                                : t('settings.accounts.apiKey.value.showAria')
                            }
                          >
                            {apiKeyShow ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      </Field>

                      {apiKeyProvider === 'openai-compatible' && (
                        <Field
                          label={t('settings.accounts.apiKey.baseUrl.label')}
                          hint={t('settings.accounts.apiKey.baseUrl.hint')}
                        >
                          <input
                            className="settings-view__input"
                            type="url"
                            value={apiKeyBaseUrl}
                            onChange={(e) => setApiKeyBaseUrl(e.target.value)}
                            placeholder={
                              editingMode === 'manual'
                                ? t('settings.accounts.edit.secretPlaceholder')
                                : t('settings.accounts.apiKey.baseUrl.placeholder')
                            }
                            autoComplete="off"
                            disabled={providerAuthBusyId !== null}
                            data-testid="provider-auth-api-key-base-url"
                          />
                        </Field>
                      )}

                      {apiKeyProvider === 'deepseek' && (
                        <Field
                          label="Console userToken"
                          hint="可选；从 platform.deepseek.com 的 LocalStorage 复制 userToken，可解锁日用量柱状图。"
                        >
                          <div className="settings-view__input-affix">
                            <input
                              className="settings-view__input"
                              type={
                                deepseekUserTokenShow ? 'text' : 'password'
                              }
                              value={deepseekUserToken}
                              onChange={(e) =>
                                setDeepseekUserToken(e.target.value)
                              }
                              placeholder={
                                editingMode === 'manual'
                                  ? t('settings.accounts.edit.secretPlaceholder')
                                  : '留空则只显示余额'
                              }
                              autoComplete="off"
                              disabled={
                                providerAuthBusyId !== null
                              }
                              data-testid="provider-auth-deepseek-user-token"
                            />
                            <button
                              type="button"
                              className="settings-view__input-action"
                              onClick={() =>
                                setDeepseekUserTokenShow((v) => !v)
                              }
                              aria-label={
                                deepseekUserTokenShow
                                  ? '隐藏 userToken'
                                  : '显示 userToken'
                              }
                            >
                              {deepseekUserTokenShow ? (
                                <EyeOff size={14} />
                              ) : (
                                <Eye size={14} />
                              )}
                            </button>
                          </div>
                        </Field>
                      )}
                    </>
                  )}
                </div>

                <div className="settings-view__management-actions">
                  <button
                    type="button"
                    className="settings-view__btn-secondary"
                    onClick={() => {
                      if (editingMode === 'manual') {
                        void handleProviderAuthUpdate();
                      } else {
                        void handleProviderAuthCreateApiKey();
                      }
                    }}
                    disabled={providerAuthBusyId !== null}
                    data-testid="provider-auth-api-key-submit"
                  >
                    <Check size={13} strokeWidth={2} aria-hidden="true" />
                    {providerAuthBusyId !== null
                      ? t('settings.accounts.apiKey.submitting')
                      : editingMode === 'manual'
                        ? t('settings.accounts.apiKey.submit')
                        : t('settings.accounts.apiKey.submit')}
                  </button>
                  <button
                    type="button"
                    className="settings-view__btn-secondary"
                    onClick={() => {
                      if (editingProviderAuthId !== null) {
                        handleProviderAuthEditCancel();
                      } else {
                        setApiKeyFormOpen(false);
                        setApiKeyValue('');
                        setApiKeyShow(false);
                        setXiaomiPassToken('');
                        setXiaomiUserId('');
                        setXiaomiPassTokenShow(false);
                        setDeepseekUserToken('');
                        setDeepseekUserTokenShow(false);
                        setOpencodeAuthCookie('');
                        setOpencodeWorkspaceUrl('');
                        setOpencodeAuthCookieShow(false);
                        setProviderAuthError(null);
                      }
                    }}
                    disabled={providerAuthBusyId !== null}
                  >
                    {editingProviderAuthId !== null
                      ? t('settings.accounts.edit.cancel')
                      : t('confirmDialog.cancel')}
                  </button>
                </div>
              </div>
            )}


            {providerAuthError !== null && (
              <p
                className="settings-view__error-msg"
                role="alert"
                data-testid="provider-auth-error"
              >
                <AlertCircle size={12} strokeWidth={2} aria-hidden="true" />
                {' '}
                {formatProviderAuthError(t, providerAuthError)}
              </p>
            )}

            <ProviderAuthList
              rows={providerAuthRows}
              onRefresh={(id) => void handleProviderAuthRefresh(id)}
              onDelete={(id) => void handleProviderAuthDelete(id)}
              onEdit={handleProviderAuthEdit}
              editingRowId={editingProviderAuthId}
              editPanel={
                editingProviderAuthId !== null ? (
                  editingMode === 'reimport' ? (
                    /* Reimport panel for cpa-auth-file accounts */
                    <div className="settings-view__edit-inline" data-testid="provider-auth-reimport-panel">
                      <div className="settings-view__edit-inline-row">
                        <Field label={t('settings.accounts.apiKey.displayName.label')}>
                          <input
                            className="settings-view__input"
                            type="text"
                            value={apiKeyLabel}
                            onChange={(e) => setApiKeyLabel(e.target.value)}
                            placeholder={t('settings.accounts.apiKey.displayName.placeholder')}
                            disabled={providerAuthBusyId !== null}
                            data-testid="provider-auth-reimport-label"
                          />
                        </Field>
                      </div>
                      <div className="settings-view__edit-inline-actions">
                        <button
                          type="button"
                          className="settings-view__btn-secondary"
                          onClick={() => void handleProviderAuthReimport(editingProviderAuthId)}
                          disabled={providerAuthBusyId !== null}
                          data-testid="provider-auth-reimport-submit"
                        >
                          {providerAuthBusyId === editingProviderAuthId
                            ? t('settings.accounts.import.busy')
                            : t('settings.accounts.edit.reimport')}
                        </button>
                        <button
                          type="button"
                          className="settings-view__btn-ghost"
                          onClick={handleProviderAuthEditCancel}
                          disabled={providerAuthBusyId !== null}
                        >
                          {t('settings.accounts.edit.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Inline edit form for manual-api-key accounts */
                    <div className="settings-view__edit-inline" data-testid="provider-auth-edit-panel">
                      <div className="settings-view__edit-inline-row">
                        <Field label={t('settings.accounts.apiKey.displayName.label')}>
                          <input
                            className="settings-view__input"
                            type="text"
                            value={apiKeyLabel}
                            onChange={(e) => setApiKeyLabel(e.target.value)}
                            placeholder={t('settings.accounts.apiKey.displayName.placeholder')}
                            disabled={providerAuthBusyId !== null}
                          />
                        </Field>
                        {apiKeyProvider === 'xiaomi' ? (
                          <>
                            <Field label="passToken">
                              <input
                                className="settings-view__input"
                                type="password"
                                value={xiaomiPassToken}
                                onChange={(e) => setXiaomiPassToken(e.target.value)}
                                placeholder={t('settings.accounts.edit.secretPlaceholder')}
                                disabled={providerAuthBusyId !== null}
                              />
                            </Field>
                            <Field label="userId">
                              <input
                                className="settings-view__input"
                                type="text"
                                value={xiaomiUserId}
                                onChange={(e) => setXiaomiUserId(e.target.value)}
                                placeholder={t('settings.accounts.edit.secretPlaceholder')}
                                disabled={providerAuthBusyId !== null}
                              />
                            </Field>
                          </>
                        ) : apiKeyProvider === 'opencode' ? (
                          <>
                            <Field label="Auth Cookie">
                              <input
                                className="settings-view__input"
                                type="password"
                                value={opencodeAuthCookie}
                                onChange={(e) => setOpencodeAuthCookie(e.target.value)}
                                placeholder={t('settings.accounts.edit.secretPlaceholder')}
                                disabled={providerAuthBusyId !== null}
                              />
                            </Field>
                            <Field label="Workspace URL">
                              <input
                                className="settings-view__input"
                                type="url"
                                value={opencodeWorkspaceUrl}
                                onChange={(e) => setOpencodeWorkspaceUrl(e.target.value)}
                                placeholder={t('settings.accounts.edit.secretPlaceholder')}
                                disabled={providerAuthBusyId !== null}
                              />
                            </Field>
                          </>
                        ) : (
                          <>
                            <Field label={t('settings.accounts.apiKey.value.label')}>
                              <input
                                className="settings-view__input"
                                type="password"
                                value={apiKeyValue}
                                onChange={(e) => setApiKeyValue(e.target.value)}
                                placeholder={t('settings.accounts.edit.secretPlaceholder')}
                                disabled={providerAuthBusyId !== null}
                              />
                            </Field>
                            {apiKeyProvider === 'openai-compatible' && (
                              <Field label={t('settings.accounts.apiKey.baseUrl.label')}>
                                <input
                                  className="settings-view__input"
                                  type="url"
                                  value={apiKeyBaseUrl}
                                  onChange={(e) => setApiKeyBaseUrl(e.target.value)}
                                  placeholder={t('settings.accounts.edit.secretPlaceholder')}
                                  disabled={providerAuthBusyId !== null}
                                />
                              </Field>
                            )}
                          </>
                        )}
                      </div>
                      <div className="settings-view__edit-inline-actions">
                        <button
                          type="button"
                          className="settings-view__btn-secondary"
                          onClick={() => void handleProviderAuthUpdate()}
                          disabled={providerAuthBusyId !== null}
                          data-testid="provider-auth-edit-submit"
                        >
                          {providerAuthBusyId !== null
                            ? t('settings.accounts.apiKey.submitting')
                            : t('settings.accounts.apiKey.submit')}
                        </button>
                        <button
                          type="button"
                          className="settings-view__btn-ghost"
                          onClick={handleProviderAuthEditCancel}
                          disabled={providerAuthBusyId !== null}
                        >
                          {t('settings.accounts.edit.cancel')}
                        </button>
                      </div>
                    </div>
                  )
                ) : undefined
              }
              onToggleEnabled={(id, enabled) =>
                void toggleProviderAuthEnabled(id, enabled)
              }
              kiroTokenRefresh={
                settings.kiroTokenRefresh ?? DEFAULT_KIRO_TOKEN_REFRESH
              }
              onKiroRefreshSettingsChange={updateKiroTokenRefresh}
              busyId={providerAuthBusyId}
            />
          </Section>

          {/* Padding so sticky save bar doesn't overlap last section */}
          <div className="settings-view__form-pad" aria-hidden="true" />
        </form>
      </div>

      {/* ── Sticky save bar ────────────────────────────────── */}
      <div
        className={`settings-view__savebar${
          dirty || saveSuccess || saveError ? ' settings-view__savebar--show' : ''
        }`}
        role="status"
      >
        <div className="settings-view__savebar-msg">
          {saveError ? (
            <span className="settings-view__savebar-err" role="alert">
              <AlertCircle size={14} strokeWidth={2} />
              {saveError}
            </span>
          ) : saveSuccess ? (
            <span className="settings-view__savebar-ok">
              <Check size={14} strokeWidth={2} />
              {t('settings.action.saved')}
            </span>
          ) : errorCount > 0 ? (
            <span className="settings-view__savebar-err">
              <AlertCircle size={14} strokeWidth={2} />
              {errorCount} 处校验未通过
            </span>
          ) : (
            <span className="settings-view__savebar-dirty">有未保存的更改</span>
          )}
        </div>
        <div className="settings-view__savebar-actions">
          <button
            type="button"
            className="settings-view__btn-secondary"
            onClick={handleDiscard}
            disabled={!dirty || saving}
          >
            {t('settings.action.discard')}
          </button>
          <button
            type="button"
            className="settings-view__btn-primary"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
          >
            {saving ? '保存中…' : t('settings.action.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface SectionProps {
  readonly id: string;
  readonly section?: SectionDef;
  readonly title?: string;
  readonly hint?: string;
  readonly icon?: JSX.Element;
  readonly children?: React.ReactNode;
}

function Section({
  id,
  section,
  title,
  hint,
  icon,
  children,
}: SectionProps): JSX.Element {
  const t = useT();
  // Accept either the short id form (e.g. "collectors") used by the
  // existing eight call sites or the already-prefixed form
  // ("settings-section-provider-auth") used by newer scaffolds. We
  // normalise to a single short id internally so the DOM id and the
  // `aria-labelledby` heading id stay in sync.
  const shortId = id.startsWith('settings-section-')
    ? id.slice('settings-section-'.length)
    : id;
  const sectionId = `settings-section-${shortId}`;
  const headingId = `settings-heading-${shortId}`;
  // SectionDef carries an `i18nKey` suffix; the visible label and hint
  // are resolved through `t()` so the rail tracks the user's locale
  // (i18n-multilingual-support, Requirement 4.2). Explicit `title` /
  // `hint` props still override (used by the Provider_Auth scaffold).
  const sectionLabel = section
    ? t(`settings.section.${section.i18nKey}.label` as TranslationKey)
    : '';
  const sectionHint = section
    ? t(`settings.section.${section.i18nKey}.hint` as TranslationKey)
    : '';
  const resolvedTitle = title ?? sectionLabel;
  const resolvedHint = hint ?? sectionHint;
  const resolvedIcon = icon ?? section?.icon ?? null;
  return (
    <section
      id={sectionId}
      className="settings-view__section"
      aria-labelledby={headingId}
    >
      <header className="settings-view__section-head">
        {resolvedIcon && (
          <span className="settings-view__section-icon" aria-hidden="true">
            {resolvedIcon}
          </span>
        )}
        <div className="settings-view__section-titles">
          <h3
            id={headingId}
            className="settings-view__section-title"
          >
            {resolvedTitle}
          </h3>
          <p className="settings-view__section-hint">{resolvedHint}</p>
        </div>
      </header>
      <div className="settings-view__section-body">{children}</div>
    </section>
  );
}

interface FieldProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: React.ReactNode;
}

function Field({ label, hint, error, children }: FieldProps): JSX.Element {
  return (
    <label className="settings-view__field">
      <span className="settings-view__field-head">
        <span className="settings-view__label">{label}</span>
        {hint && <span className="settings-view__hint">{hint}</span>}
      </span>
      {children}
      {error && (
        <span className="settings-view__error-msg" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

interface ListFieldProps {
  readonly items: readonly string[];
  readonly placeholder: string;
  readonly addLabel: string;
  readonly type: 'url' | 'text';
  readonly variant?: 'single' | 'paired';
  readonly onUpdate: (index: number, value: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
  readonly ariaLabel: string;
}

function ListField({
  items,
  placeholder,
  addLabel,
  type,
  variant = 'paired',
  onUpdate,
  onAdd,
  onRemove,
  ariaLabel,
}: ListFieldProps): JSX.Element {
  return (
    <div
      className={`settings-view__list${
        variant === 'single' ? ' settings-view__list--single' : ''
      }`}
    >
      {items.length === 0 && (
        <p className="settings-view__empty">尚未配置任何条目</p>
      )}
      {items.map((value, i) => (
        <div className="settings-view__list-row" key={i}>
          <span className="settings-view__list-index">{String(i + 1).padStart(2, '0')}</span>
          <input
            className="settings-view__input"
            type={type}
            value={value}
            onChange={(e) => onUpdate(i, e.target.value)}
            placeholder={placeholder}
            aria-label={`${ariaLabel} ${i + 1}`}
          />
          <button
            type="button"
            className="settings-view__btn-icon"
            onClick={() => onRemove(i)}
            aria-label={`删除 ${ariaLabel} ${i + 1}`}
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="settings-view__btn-add"
        onClick={onAdd}
      >
        <Plus size={14} strokeWidth={2} />
        <span>{addLabel}</span>
      </button>
    </div>
  );
}

interface ToggleFieldProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}

function ToggleField({ label, hint, checked, onChange }: ToggleFieldProps): JSX.Element {
  return (
    <label className="settings-view__field settings-view__field--toggle">
      <span className="settings-view__field-head">
        <span className="settings-view__label">{label}</span>
        {hint && <span className="settings-view__hint">{hint}</span>}
      </span>
      <span className={`settings-view__switch${checked ? ' settings-view__switch--on' : ''}`}>
        <input
          type="checkbox"
          className="settings-view__switch-input"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="settings-view__switch-track" aria-hidden="true">
          <span className="settings-view__switch-thumb" />
        </span>
      </span>
    </label>
  );
}

interface SegmentedControlOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SegmentedControlProps<T extends string> {
  readonly value: T;
  readonly options: readonly SegmentedControlOption<T>[];
  readonly onChange: (next: T) => void;
  readonly ariaLabel: string;
}

/**
 * Two- or three-button segmented selector. We intentionally stay
 * keyboard-first: each button is a `role="radio"` inside a
 * `role="radiogroup"` so tab order stays simple, and `aria-checked`
 * tracks the active value.
 */
function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SegmentedControlProps<T>): JSX.Element {
  return (
    <div
      className="settings-view__segmented"
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`settings-view__segmented-btn${
              active ? ' settings-view__segmented-btn--active' : ''
            }`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
