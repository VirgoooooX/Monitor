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
  ManagementConfigFileEntry,
  ManualApiKeyProvider,
  ProviderAuthMetadata,
  ProviderId,
  RefreshIntervalSettings,
} from '../lib/types';
import {
  PROVIDER_LABELS,
  PROVIDER_AUTH_ERROR_LABELS,
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
};

interface CompactThemeOption {
  readonly id: CompactTheme;
  readonly label: string;
  readonly description: string;
}

const COMPACT_THEME_OPTIONS: readonly CompactThemeOption[] = [
  // v2 design-language presets
  {
    id: 'liquid-glass',
    label: '液态玻璃',
    description: '浅色半透明玻璃，桌面 widget 般通透。',
  },
  {
    id: 'material-you',
    label: 'Material You',
    description: '浅色 MD3 双色块，亲和现代。',
  },
  {
    id: 'soft-neumorph',
    label: '柔和拟态',
    description: '浅色凸起外壳与内凹槽，安静低噪。',
  },
  {
    id: 'paper-dashboard',
    label: '纸感仪表',
    description: '近白纸面 + 细线分隔，办公低干扰。',
  },
  {
    id: 'mint-monitor',
    label: '薄荷监控',
    description: '暗色半透明卡片，参考图风格。',
  },
  {
    id: 'device-oled',
    label: '硬件 OLED',
    description: '金属外壳 + 黑色 OLED 屏 + LED 段条。',
  },
  // v1 legacy presets (retained for users who preferred them)
  {
    id: 'obsidian-glass',
    label: '黑曜玻璃',
    description: '深色磨砂质感，桌面常驻不抢眼。',
  },
  {
    id: 'aurora-ring',
    label: '极光环',
    description: '边缘极光缓慢流动，状态色感强。',
  },
  {
    id: 'holo-grid',
    label: '全息网格',
    description: 'HUD 风格网格 + 慢扫描线。',
  },
  {
    id: 'liquid-metal',
    label: '液态金属',
    description: '石墨与冷光泽，适合深色桌面。',
  },
  {
    id: 'signal-pulse',
    label: '信号脉冲',
    description: '随状态色脉动的同心圆。',
  },
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
 */
function validateManagementUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '必须是 http:// 或 https:// 开头的合法 URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '必须使用 http:// 或 https://';
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'URL 不应包含用户名或密码';
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return 'URL 不应包含 query 或 fragment';
  }
  return undefined;
}

function validateSettings(settings: AppSettings): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!HTTP_URL_RE.test(settings.controllerUrl)) {
    errors.controllerUrl = '必须是 http:// 或 https:// 开头的 URL';
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
  const urlError = validateManagementUrl(settings.managementInterface.url);
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
  readonly label: string;
  readonly hint: string;
  readonly icon: JSX.Element;
}

const SECTIONS: readonly SectionDef[] = [
  {
    id: 'appearance',
    label: '外观',
    hint: '深浅色与悬浮窗风格',
    icon: <Palette size={14} strokeWidth={1.75} />,
  },
  {
    id: 'controller',
    label: '控制器',
    hint: 'OpenClash 主控连接',
    icon: <Server size={14} strokeWidth={1.75} />,
  },
  {
    id: 'probes',
    label: '探测目标',
    hint: '外网连通性 URL',
    icon: <Radar size={14} strokeWidth={1.75} />,
  },
  {
    id: 'groups',
    label: '主分组',
    hint: '展示与切换',
    icon: <Layers size={14} strokeWidth={1.75} />,
  },
  {
    id: 'router',
    label: '路由器',
    hint: '内网健康检测',
    icon: <Router size={14} strokeWidth={1.75} />,
  },
  {
    id: 'intervals',
    label: '刷新节奏',
    hint: '采样频率 (ms)',
    icon: <Timer size={14} strokeWidth={1.75} />,
  },
  {
    id: 'switching',
    label: '切换',
    hint: '节点切换行为',
    icon: <ArrowLeftRight size={14} strokeWidth={1.75} />,
  },
  {
    id: 'management',
    label: '管理接口',
    hint: 'OpenClash LuCI',
    icon: <Network size={14} strokeWidth={1.75} />,
  },
  {
    id: 'accounts',
    label: 'AI 账号',
    hint: '导入认证文件或填写 API key',
    icon: <Sparkles size={14} strokeWidth={1.75} />,
  },
];

// Friendly labels + hints for refresh interval keys.
const INTERVAL_META: Record<keyof RefreshIntervalSettings, { label: string; hint: string }> = {
  networkMs: { label: '网络', hint: '路由 + 外网探测' },
  openclashMs: { label: 'OpenClash', hint: 'API / 模式轮询' },
  currentNodeMs: { label: '当前节点', hint: '延迟与丢包采样' },
  nodeScanMs: { label: '节点扫描', hint: '全量节点列表' },
  usageMs: { label: 'AI 用量', hint: 'Token / 配额刷新' },
  retentionMs: { label: '清理', hint: '历史数据保留' },
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
  'gemini-api',
  'deepseek',
  'xiaomi',
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
function extractIpcError(err: unknown): { code: string; message: string } {
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
  return { code: 'unknown', message: '未知错误' };
}

/**
 * Render copy for a Provider_Auth IPC error envelope. Maps the
 * closed `ProviderAuthErrorCode` set to the same zh-CN labels
 * `ProviderAuthList` uses for status badges (single source of
 * truth: `PROVIDER_AUTH_ERROR_LABELS`); falls back to the raw
 * envelope message for codes outside the closed set (`'protocol'`,
 * `'unknown'`, IPC validation failures from outside the Provider_Auth
 * code list, etc.).
 */
function formatProviderAuthError(envelope: {
  code: string;
  message: string;
}): string {
  const known = (PROVIDER_AUTH_ERROR_LABELS as Record<string, string>)[
    envelope.code
  ];
  if (typeof known === 'string') {
    return envelope.message.length > 0
      ? `${known}：${envelope.message}`
      : known;
  }
  return envelope.message.length > 0
    ? envelope.message
    : `导入失败 (${envelope.code})`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsView(): JSX.Element {
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
    desktop
      .listProviderAuths()
      .then((rows) => {
        setProviderAuthRows(rows);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[SettingsView] listProviderAuths failed:', err);
        setProviderAuthError(extractIpcError(err));
      });
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
        setProviderAuthError(extractIpcError(err));
      } finally {
        setProviderAuthBusyId(null);
      }
    },
    [],
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
        err instanceof Error ? err.message : '清除凭据时发生未知错误';
      setSaveError(message);
    }
  }, []);

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
      const envelope = extractIpcError(err);
      // `cancelled` is a normal user gesture (Requirement 8.3) —
      // do not surface it as an error.
      if (envelope.code !== 'cancelled') {
        setProviderAuthError(envelope);
      }
    } finally {
      setProviderAuthBusyId(null);
    }
  }, [providerPick]);

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
      setProviderAuthError(extractIpcError(err));
    } finally {
      setProviderAuthBusyId(null);
    }
  }, []);

  const handleProviderAuthDelete = useCallback(async (id: string) => {
    const desktop = window.desktop;
    if (!desktop) return;
    setProviderAuthBusyId(id);
    setProviderAuthError(null);
    try {
      await desktop.deleteProviderAuth({ id });
      setProviderAuthRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err: unknown) {
      setProviderAuthError(extractIpcError(err));
    } finally {
      setProviderAuthBusyId(null);
    }
  }, []);

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
    const trimmedKey = apiKeyValue.trim();
    if (trimmedKey.length === 0) {
      setProviderAuthError({
        code: 'validation',
        message: 'API key 不能为空',
      });
      return;
    }
    if (
      apiKeyProvider === 'openai-compatible' &&
      apiKeyBaseUrl.trim().length === 0
    ) {
      setProviderAuthError({
        code: 'validation',
        message: 'OpenAI 兼容账号必须填写 Base URL',
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
      setApiKeyFormOpen(false);
    } catch (err: unknown) {
      setProviderAuthError(extractIpcError(err));
    } finally {
      setProviderAuthBusyId(null);
    }
  }, [apiKeyProvider, apiKeyLabel, apiKeyValue, apiKeyBaseUrl]);

  // ---------------------------------------------------------------------------
  // Save / discard handlers
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!settings) return;
    const desktop = window.desktop;
    if (!desktop) return;

    const validationErrors = validateSettings(settings);
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
        err instanceof Error ? err.message : 'Unknown error during save';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [settings, secret, luciUsername, luciPassword]);

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
      <div className="settings-view" role="main" aria-label="设置">
        <p className="settings-view__loading">加载设置中…</p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="settings-view" role="main" aria-label="设置">
        <p className="settings-view__error">无法加载设置</p>
      </div>
    );
  }

  return (
    <div className="settings-view" role="main" aria-label="设置">
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
        <nav className="settings-view__rail" aria-label="设置导航">
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
                    <span className="settings-view__rail-label">{s.label}</span>
                    <span className="settings-view__rail-hint">{s.hint}</span>
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
            <Field
              label="色彩模式"
              hint="仅影响展开窗；悬浮窗使用下方主题。"
            >
              <SegmentedControl<ColorMode>
                value={(settings.appearance ?? DEFAULT_APPEARANCE).colorMode}
                options={[
                  { value: 'dark', label: '深色' },
                  { value: 'light', label: '浅色' },
                ]}
                onChange={(v) => updateAppearance({ colorMode: v })}
                ariaLabel="色彩模式"
              />
            </Field>

            <Field
              label="界面字号"
              hint="统一调整展开窗的标题、正文、按钮、表格和输入框字号。"
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
                  aria-label="界面字号比例"
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

            <div className="settings-view__theme-grid">
              {COMPACT_THEME_OPTIONS.map((opt) => {
                const active =
                  (settings.appearance ?? DEFAULT_APPEARANCE).compactTheme ===
                  opt.id;
                return (
                  <button
                    type="button"
                    key={opt.id}
                    className={`settings-view__theme-card${
                      active ? ' settings-view__theme-card--active' : ''
                    }`}
                    onClick={() => updateAppearance({ compactTheme: opt.id })}
                    aria-pressed={active}
                    aria-label={`悬浮窗主题：${opt.label}`}
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
                        {opt.label}
                        {active && (
                          <Check
                            size={12}
                            strokeWidth={2.4}
                            className="settings-view__theme-check"
                          />
                        )}
                      </span>
                      <span className="settings-view__theme-desc">
                        {opt.description}
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
                label="Controller URL"
                hint="OpenClash 主控制器地址，需以 http(s):// 开头"
                error={errors.controllerUrl}
              >
                <input
                  className="settings-view__input"
                  type="url"
                  value={settings.controllerUrl}
                  onChange={(e) => updateField('controllerUrl', e.target.value)}
                  aria-invalid={!!errors.controllerUrl}
                  placeholder="http://192.168.1.1:9090"
                />
              </Field>

              <Field
                label="Secret"
                hint="仅写入；保存后清空，不显示当前值"
              >
                <div className="settings-view__input-affix">
                  <input
                    className="settings-view__input"
                    type={showSecret ? 'text' : 'password'}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="留空则保留现有 secret"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="settings-view__input-action"
                    onClick={() => setShowSecret((v) => !v)}
                    aria-label={showSecret ? '隐藏 secret' : '显示 secret'}
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
              placeholder="https://example.com"
              addLabel="添加探测 URL"
              type="url"
              variant="single"
              onUpdate={updateProbeUrl}
              onAdd={addProbeUrl}
              onRemove={removeProbeUrl}
              ariaLabel="Probe URL"
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
              placeholder="group name"
              addLabel="添加分组"
              type="text"
              onUpdate={updatePrimaryGroup}
              onAdd={addPrimaryGroup}
              onRemove={removePrimaryGroup}
              ariaLabel="Primary Group"
            />
          </Section>

          {/* ── Router Health ────────────────────────────────── */}
          <Section id="router" section={SECTIONS[4]!}>
            <div className="settings-view__row settings-view__row--router">
              <Field label="Host" hint="路由器内网地址">
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
                  placeholder="192.168.1.1"
                />
              </Field>
              <Field
                label="Port"
                hint="1 - 65535"
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
                return (
                  <Field key={key} label={meta.label} hint={meta.hint}>
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
                label="验证延迟"
                hint="切换后等待节点稳定的时间 (0 - 10000 ms)"
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
                label="切换前确认"
                hint="切换到不同节点时弹出二次确认"
                checked={settings.switchConfirmation}
                onChange={(v) => updateField('switchConfirmation', v)}
              />
            </div>
          </Section>

          {/* ── OpenClash 管理接口 ───────────────────────────── */}
          <Section id="management" section={SECTIONS[7]!}>
            <div className="settings-view__row">
              <Field
                label="LuCI URL"
                hint="OpenWrt LuCI 面板地址 (http(s)://host[:port])，留空表示未配置"
                error={errors.managementUrl}
              >
                <input
                  className="settings-view__input"
                  type="url"
                  value={settings.managementInterface.url}
                  onChange={(e) => updateManagementUrl(e.target.value)}
                  aria-invalid={!!errors.managementUrl}
                  placeholder="http://192.168.31.100"
                />
              </Field>

              <Field
                label="请求超时"
                hint="管理接口单次请求超时 (1000 - 30000 ms)"
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
                label="配置切换校验窗口"
                hint="切换配置后等待 Clash 内核完成重载的时间 (1000 - 30000 ms)"
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
                label="LuCI 用户名"
                hint="留空则保留现有凭据"
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
                  placeholder="留空则保留现有用户名"
                  autoComplete="off"
                />
              </Field>

              <Field
                label="LuCI 密码"
                hint="仅写入；保存后清空，不显示当前值"
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
                    placeholder="留空则保留现有密码"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="settings-view__input-action"
                    onClick={() => setShowLuciPassword((v) => !v)}
                    aria-label={showLuciPassword ? '隐藏密码' : '显示密码'}
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
                清除管理接口凭据
              </button>
              {credsCleared && (
                <span
                  className="settings-view__management-cleared"
                  role="status"
                >
                  <Check size={12} strokeWidth={2} />
                  已清除存储的凭据
                </span>
              )}
            </div>

            {/* Whitelist editor — alias + path rows. The renderer
                surfaces the alias to users (Requirement 4.4); the
                path is sent verbatim to the management interface
                and validated against `CONFIG_PATH_RE`. */}
            <div className="settings-view__whitelist">
              <header className="settings-view__whitelist-head">
                <span className="settings-view__label">配置文件白名单</span>
                <span className="settings-view__hint">
                  手工维护的可切换 OpenClash 配置文件列表 (路径需形如
                  /etc/openclash/config/*.yaml)
                </span>
              </header>
              {settings.managementInterface.configFileWhitelist.length === 0 && (
                <p className="settings-view__empty">尚未配置任何条目</p>
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
                      placeholder="别名 (例如 备用机场)"
                      aria-label={`配置文件别名 ${i + 1}`}
                    />
                    <input
                      className="settings-view__input"
                      type="text"
                      value={entry.path}
                      onChange={(e) =>
                        updateWhitelistEntry(i, { path: e.target.value })
                      }
                      placeholder="/etc/openclash/config/example.yaml"
                      aria-label={`配置文件路径 ${i + 1}`}
                    />
                    <button
                      type="button"
                      className="settings-view__btn-icon"
                      onClick={() => removeWhitelistEntry(i)}
                      aria-label={`删除白名单条目 ${i + 1}`}
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
                <span>添加白名单条目</span>
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
                label="账号类型 (CPA 文件)"
                hint="选择这份 CPA 认证文件对应的服务"
              >
                <select
                  className="settings-view__input"
                  value={providerPick}
                  onChange={(e) =>
                    setProviderPick(e.target.value as ProviderId)
                  }
                  aria-label="账号类型 (CPA 文件)"
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
                label="操作"
                hint="主进程打开文件选择器，不向页面暴露 token / API key"
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
                      ? '导入中…'
                      : '导入 CPA 认证文件'}
                  </button>
                  <button
                    type="button"
                    className="settings-view__btn-secondary"
                    onClick={() => {
                      setApiKeyFormOpen((v) => !v);
                      setProviderAuthError(null);
                    }}
                    disabled={providerAuthBusyId === '__create__'}
                    data-testid="provider-auth-open-api-key-form"
                    aria-expanded={apiKeyFormOpen}
                  >
                    <KeyRound size={13} strokeWidth={2} aria-hidden="true" />
                    {apiKeyFormOpen ? '收起 API Key 表单' : '输入 API Key'}
                  </button>
                </div>
              </Field>
            </div>

            {apiKeyFormOpen && (
              <div
                className="settings-view__api-key-form"
                data-testid="provider-auth-api-key-form"
              >
                <div className="settings-view__row">
                  <Field
                    label="账号类型"
                    hint="只支持纯 API key 的服务；OAuth 类账号请使用 CPA 文件导入"
                  >
                    <select
                      className="settings-view__input"
                      value={apiKeyProvider}
                      onChange={(e) =>
                        setApiKeyProvider(
                          e.target.value as ManualApiKeyProvider,
                        )
                      }
                      aria-label="API key 账号类型"
                      disabled={providerAuthBusyId === '__create__'}
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
                    label="显示名称"
                    hint="可选；留空使用默认名称"
                  >
                    <input
                      className="settings-view__input"
                      type="text"
                      value={apiKeyLabel}
                      onChange={(e) => setApiKeyLabel(e.target.value)}
                      placeholder="例如 主账号 / 备用 key"
                      autoComplete="off"
                      disabled={providerAuthBusyId === '__create__'}
                      data-testid="provider-auth-api-key-label"
                    />
                  </Field>
                </div>

                <div className="settings-view__row">
                  <Field
                    label="API Key"
                    hint="保存后即加密落库；保存成功不再回显"
                  >
                    <div className="settings-view__input-affix">
                      <input
                        className="settings-view__input"
                        type={apiKeyShow ? 'text' : 'password'}
                        value={apiKeyValue}
                        onChange={(e) => setApiKeyValue(e.target.value)}
                        placeholder="sk-..."
                        autoComplete="off"
                        disabled={providerAuthBusyId === '__create__'}
                        data-testid="provider-auth-api-key-value"
                      />
                      <button
                        type="button"
                        className="settings-view__input-action"
                        onClick={() => setApiKeyShow((v) => !v)}
                        aria-label={apiKeyShow ? '隐藏 API key' : '显示 API key'}
                      >
                        {apiKeyShow ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </Field>

                  {apiKeyProvider === 'openai-compatible' && (
                    <Field
                      label="Base URL"
                      hint="必填，例如 https://api.example.com/v1"
                    >
                      <input
                        className="settings-view__input"
                        type="url"
                        value={apiKeyBaseUrl}
                        onChange={(e) => setApiKeyBaseUrl(e.target.value)}
                        placeholder="https://..."
                        autoComplete="off"
                        disabled={providerAuthBusyId === '__create__'}
                        data-testid="provider-auth-api-key-base-url"
                      />
                    </Field>
                  )}
                </div>

                <div className="settings-view__management-actions">
                  <button
                    type="button"
                    className="settings-view__btn-secondary"
                    onClick={() => void handleProviderAuthCreateApiKey()}
                    disabled={providerAuthBusyId === '__create__'}
                    data-testid="provider-auth-api-key-submit"
                  >
                    <Check size={13} strokeWidth={2} aria-hidden="true" />
                    {providerAuthBusyId === '__create__'
                      ? '保存中…'
                      : '保存账号'}
                  </button>
                  <button
                    type="button"
                    className="settings-view__btn-secondary"
                    onClick={() => {
                      setApiKeyFormOpen(false);
                      setApiKeyValue('');
                      setApiKeyShow(false);
                      setProviderAuthError(null);
                    }}
                    disabled={providerAuthBusyId === '__create__'}
                  >
                    取消
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
                {formatProviderAuthError(providerAuthError)}
              </p>
            )}

            <ProviderAuthList
              rows={providerAuthRows}
              onRefresh={(id) => void handleProviderAuthRefresh(id)}
              onDelete={(id) => void handleProviderAuthDelete(id)}
              onToggleEnabled={(id, enabled) =>
                void toggleProviderAuthEnabled(id, enabled)
              }
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
              已保存
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
            放弃
          </button>
          <button
            type="button"
            className="settings-view__btn-primary"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
          >
            {saving ? '保存中…' : '保存'}
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
  const resolvedTitle = title ?? section?.label ?? '';
  const resolvedHint = hint ?? section?.hint ?? '';
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
