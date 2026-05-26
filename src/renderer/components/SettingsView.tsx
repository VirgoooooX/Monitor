// Settings view — full-page form for configuring AppSettings.
//
// Accessible, client-side validated, write-only secret handling.
// References: design.md §Validation rules, §Property 18, §Property 19;
// PLAN.md §UI Implementation Guide §设置.

import { useCallback, useEffect, useState } from 'react';

import type { AppSettings, RefreshIntervalSettings } from '../lib/types';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

interface ValidationErrors {
  controllerUrl?: string;
  probeUrls?: string;
  routerHealthPort?: string;
  refreshIntervals?: string;
  switchVerifyDelayMs?: string;
}

const HTTP_URL_RE = /^https?:\/\//;

function validateSettings(
  settings: AppSettings,
): ValidationErrors {
  const errors: ValidationErrors = {};

  // controllerUrl: must match ^https?://
  if (!HTTP_URL_RE.test(settings.controllerUrl)) {
    errors.controllerUrl = '必须是 http:// 或 https:// 开头的 URL';
  }

  // probeUrls: each must match ^https?://, at least 1 entry
  if (settings.probeUrls.length === 0) {
    errors.probeUrls = '至少需要一个 probe URL';
  } else {
    const invalid = settings.probeUrls.filter((u) => !HTTP_URL_RE.test(u));
    if (invalid.length > 0) {
      errors.probeUrls = `以下 URL 格式无效: ${invalid.join(', ')}`;
    }
  }

  // routerHealth.port: 1..65535
  const port = settings.routerHealth.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.routerHealthPort = '端口必须在 1 - 65535 之间';
  }

  // refreshIntervals: all >= 1000
  const intervals = settings.refreshIntervals;
  const intervalKeys = Object.keys(intervals) as (keyof RefreshIntervalSettings)[];
  const badIntervals = intervalKeys.filter((k) => intervals[k] < 1000);
  if (badIntervals.length > 0) {
    errors.refreshIntervals = `以下刷新间隔必须 ≥ 1000 ms: ${badIntervals.join(', ')}`;
  }

  // switchVerifyDelayMs: 0..10000
  if (
    !Number.isInteger(settings.switchVerifyDelayMs) ||
    settings.switchVerifyDelayMs < 0 ||
    settings.switchVerifyDelayMs > 10000
  ) {
    errors.switchVerifyDelayMs = '切换验证延迟必须在 0 - 10000 ms 之间';
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Known collector IDs
// ---------------------------------------------------------------------------

const COLLECTOR_IDS = ['codex', 'gemini', 'antigravity', 'opencode', 'deepseek'] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsView(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(true);

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
        setLoading(false);
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[SettingsView] getSettings failed:', err);
        setLoading(false);
      });
  }, []);

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

  const toggleCollector = useCallback((id: string, enabled: boolean) => {
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        collectors: { ...prev.collectors, [id]: { enabled } },
      };
    });
    setSaveSuccess(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Probe URL list management
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Primary groups management
  // ---------------------------------------------------------------------------

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
  // Save handler
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
      // Send settings update (without secret — that goes via dedicated IPC).
      const updated = await desktop.updateSettings(settings);
      setSettings(updated);

      // If user entered a secret, save it via the dedicated channel.
      if (secret.trim()) {
        await desktop.updateSecret({
          key: 'openclash.controllerSecret',
          value: secret.trim(),
        });
        setSecret(''); // clear after successful save
      }

      setSaveSuccess(true);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown error during save';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [settings, secret]);

  // ---------------------------------------------------------------------------
  // Danger zone handlers
  // ---------------------------------------------------------------------------

  const handleClearAllData = useCallback(async () => {
    const desktop = window.desktop;
    if (!desktop) return;
    // The clearAllData method is expected on the desktop bridge
    // (cast to access optional future methods)
    const api = desktop as unknown as {
      clearAllData?: () => Promise<void>;
    };
    if (api.clearAllData) {
      await api.clearAllData();
    }
  }, []);

  const handleClearSecrets = useCallback(async () => {
    const desktop = window.desktop;
    if (!desktop) return;
    const api = desktop as unknown as {
      clearSecrets?: () => Promise<void>;
    };
    if (api.clearSecrets) {
      await api.clearSecrets();
    }
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
      <h2 className="settings-view__title">设置</h2>

      <form
        className="settings-view__form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
        noValidate
      >
        {/* Controller URL */}
        <fieldset className="settings-view__fieldset">
          <legend className="settings-view__legend">控制器</legend>

          <div className="settings-view__field">
            <label className="settings-view__label" htmlFor="settings-controller-url">
              Controller URL
            </label>
            <input
              id="settings-controller-url"
              className="settings-view__input"
              type="url"
              value={settings.controllerUrl}
              onChange={(e) => updateField('controllerUrl', e.target.value)}
              aria-invalid={!!errors.controllerUrl}
              aria-describedby={errors.controllerUrl ? 'settings-controller-url-error' : undefined}
              placeholder="http://192.168.1.1:9090"
            />
            {errors.controllerUrl && (
              <p id="settings-controller-url-error" className="settings-view__error-msg" role="alert">
                {errors.controllerUrl}
              </p>
            )}
          </div>

          <div className="settings-view__field">
            <label className="settings-view__label" htmlFor="settings-secret">
              Secret (仅写入)
            </label>
            <input
              id="settings-secret"
              className="settings-view__input"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="输入新 secret（不显示当前值）"
              autoComplete="off"
            />
          </div>
        </fieldset>

        {/* Probe URLs */}
        <fieldset className="settings-view__fieldset">
          <legend className="settings-view__legend">Probe URLs</legend>
          {settings.probeUrls.map((url, i) => (
            <div className="settings-view__field settings-view__field--row" key={i}>
              <label className="sr-only" htmlFor={`settings-probe-url-${i}`}>
                Probe URL {i + 1}
              </label>
              <input
                id={`settings-probe-url-${i}`}
                className="settings-view__input settings-view__input--grow"
                type="url"
                value={url}
                onChange={(e) => updateProbeUrl(i, e.target.value)}
                placeholder="https://example.com"
              />
              <button
                type="button"
                className="settings-view__btn-icon"
                onClick={() => removeProbeUrl(i)}
                aria-label={`删除 Probe URL ${i + 1}`}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="settings-view__btn-secondary"
            onClick={addProbeUrl}
          >
            + 添加 URL
          </button>
          {errors.probeUrls && (
            <p className="settings-view__error-msg" role="alert">
              {errors.probeUrls}
            </p>
          )}
        </fieldset>

        {/* Primary groups */}
        <fieldset className="settings-view__fieldset">
          <legend className="settings-view__legend">Primary Groups</legend>
          {settings.primaryGroups.map((group, i) => (
            <div className="settings-view__field settings-view__field--row" key={i}>
              <label className="sr-only" htmlFor={`settings-primary-group-${i}`}>
                Primary Group {i + 1}
              </label>
              <input
                id={`settings-primary-group-${i}`}
                className="settings-view__input settings-view__input--grow"
                type="text"
                value={group}
                onChange={(e) => updatePrimaryGroup(i, e.target.value)}
                placeholder="group name"
              />
              <button
                type="button"
                className="settings-view__btn-icon"
                onClick={() => removePrimaryGroup(i)}
                aria-label={`删除 Primary Group ${i + 1}`}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="settings-view__btn-secondary"
            onClick={addPrimaryGroup}
          >
            + 添加 Group
          </button>
        </fieldset>

        {/* Router Health */}
        <fieldset className="settings-view__fieldset">
          <legend className="settings-view__legend">路由器健康检测</legend>
          <div className="settings-view__field">
            <label className="settings-view__label" htmlFor="settings-router-host">
              Host
            </label>
            <input
              id="settings-router-host"
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
          </div>
          <div className="settings-view__field">
            <label className="settings-view__label" htmlFor="settings-router-port">
              Port
            </label>
            <input
              id="settings-router-port"
              className="settings-view__input settings-view__input--narrow"
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
              aria-describedby={errors.routerHealthPort ? 'settings-router-port-error' : undefined}
            />
            {errors.routerHealthPort && (
              <p id="settings-router-port-error" className="settings-view__error-msg" role="alert">
                {errors.routerHealthPort}
              </p>
            )}
          </div>
        </fieldset>

        {/* Refresh Intervals */}
        <fieldset className="settings-view__fieldset">
          <legend className="settings-view__legend">刷新间隔 (ms)</legend>
          {(
            Object.entries(settings.refreshIntervals) as [
              keyof RefreshIntervalSettings,
              number,
            ][]
          ).map(([key, value]) => (
            <div className="settings-view__field" key={key}>
              <label className="settings-view__label" htmlFor={`settings-interval-${key}`}>
                {key}
              </label>
              <input
                id={`settings-interval-${key}`}
                className="settings-view__input settings-view__input--narrow"
                type="number"
                min={1000}
                value={value}
                onChange={(e) => updateInterval(key, Number(e.target.value))}
              />
            </div>
          ))}
          {errors.refreshIntervals && (
            <p className="settings-view__error-msg" role="alert">
              {errors.refreshIntervals}
            </p>
          )}
        </fieldset>

        {/* Switch settings */}
        <fieldset className="settings-view__fieldset">
          <legend className="settings-view__legend">切换设置</legend>
          <div className="settings-view__field">
            <label className="settings-view__label" htmlFor="settings-switch-delay">
              验证延迟 (ms)
            </label>
            <input
              id="settings-switch-delay"
              className="settings-view__input settings-view__input--narrow"
              type="number"
              min={0}
              max={10000}
              value={settings.switchVerifyDelayMs}
              onChange={(e) => updateField('switchVerifyDelayMs', Number(e.target.value))}
              aria-invalid={!!errors.switchVerifyDelayMs}
              aria-describedby={errors.switchVerifyDelayMs ? 'settings-switch-delay-error' : undefined}
            />
            {errors.switchVerifyDelayMs && (
              <p id="settings-switch-delay-error" className="settings-view__error-msg" role="alert">
                {errors.switchVerifyDelayMs}
              </p>
            )}
          </div>
          <div className="settings-view__field settings-view__field--row">
            <input
              id="settings-switch-confirmation"
              type="checkbox"
              checked={settings.switchConfirmation}
              onChange={(e) => updateField('switchConfirmation', e.target.checked)}
            />
            <label className="settings-view__label" htmlFor="settings-switch-confirmation">
              切换前确认
            </label>
          </div>
        </fieldset>

        {/* Collector toggles */}
        <fieldset className="settings-view__fieldset">
          <legend className="settings-view__legend">采集器</legend>
          {COLLECTOR_IDS.map((id) => {
            const toggle = settings.collectors[id];
            const enabled = toggle?.enabled ?? false;
            return (
              <div className="settings-view__field settings-view__field--row" key={id}>
                <input
                  id={`settings-collector-${id}`}
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => toggleCollector(id, e.target.checked)}
                />
                <label className="settings-view__label" htmlFor={`settings-collector-${id}`}>
                  {id}
                </label>
              </div>
            );
          })}
        </fieldset>

        {/* Save */}
        <div className="settings-view__actions">
          <button
            type="submit"
            className="settings-view__btn-primary"
            disabled={saving}
          >
            {saving ? '保存中…' : '保存设置'}
          </button>
          {saveSuccess && (
            <span className="settings-view__success" role="status">
              已保存
            </span>
          )}
          {saveError && (
            <span className="settings-view__save-error" role="alert">
              {saveError}
            </span>
          )}
        </div>
      </form>

      {/* Danger zone — hidden until IPC is implemented (v2) */}
      {/* <fieldset className="settings-view__fieldset settings-view__fieldset--danger">
        <legend className="settings-view__legend settings-view__legend--danger">
          危险操作
        </legend>
        <button type="button" className="settings-view__btn-danger" onClick={() => void handleClearAllData()}>清除所有本地数据</button>
        <button type="button" className="settings-view__btn-danger" onClick={() => void handleClearSecrets()}>清除凭据</button>
      </fieldset> */}
    </div>
  );
}
