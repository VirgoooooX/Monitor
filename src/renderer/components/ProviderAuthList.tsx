// ProviderAuthList — per-account row list for the Provider_Auth section.
//
// Renders one row per imported `provider_auth` row, with the following
// affordances:
//
//   • Provider chip (zh-CN brand label, e.g. "Claude Code", "小米 Mimo")
//   • User-readable label + accountId / projectId tail
//   • Capability chip ("官方 Quota" / "可用性检查" / "本地用量" / "未支持")
//   • Two timestamp slots — last validated / last quota fetch
//   • Status badge derived from `lastErrorCode`
//   • A refresh button (disabled while a refresh is in-flight; most
//     `auth_expired` rows still require re-import, while Google Code
//     Assist rows are allowed one retry because CPA exports carry
//     ambiguous timestamp fields that can be misread as token expiry)
//   • A delete button
//
// Special cases drawn from `requirements.md` Requirements 5.4, 6.5,
// 12.2..12.5:
//
//   • For `quotaCapability ∈ { 'health_only', 'usage_only' }` the row
//     replaces the percentage-style "official Quota" verbiage with the
//     copy "暂无官方 quota 接口，仅做可用性 / 本地统计". This keeps the
//     UI honest — DeepSeek / Xiaomi / OpenAI-compatible accounts must
//     never appear as if they were producing first-party quota data.
//   • For `lastErrorCode === 'auth_expired'` the row shows recovery
//     copy. Non-Google rows disable refresh; Gemini CLI / Antigravity
//     rows keep refresh enabled so a stale false-positive expiry can
//     be retried after CPA/local credentials have changed.
//
// Multi-account ordering: rows are stable-sorted by `importedAt` ASC
// inside the component, mirroring the repository's default ordering.
// Rows for the same provider stack vertically — they are NOT merged
// into a single bar (Requirement 12.4).
//
// References:
//   • cpa-quota-import/requirements.md Requirements 5.4, 6.5, 12.2..12.5
//   • cpa-quota-import/design.md §Settings UI, §Components and Interfaces
//   • src/renderer/components/SettingsView.tsx for the Section/Field
//     visual rhythm this list lives inside.

import { useMemo } from 'react';
import { RefreshCw, Trash2, AlertCircle, KeyRound, Clock } from 'lucide-react';

import { ProviderIcon } from './ProviderIcon';
import type {
  ProviderAuthErrorCode,
  ProviderAuthMetadata,
  ProviderId,
  QuotaCapability,
} from '../lib/types';

// ---------------------------------------------------------------------------
// zh-CN label maps
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the zh-CN brand label rendered in the
 * provider chip. The `Record<ProviderId, string>` typing makes the
 * map provably total — adding a new `ProviderId` member is a
 * compile-time error here, mirroring the totality pattern used by
 * `MANAGEMENT_ERROR_LABELS` in `format.ts`.
 */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex (ChatGPT)',
  'gemini-cli': 'Gemini CLI',
  antigravity: 'Antigravity',
  'gemini-api': 'Gemini API',
  deepseek: 'DeepSeek',
  xiaomi: '小米 Mimo',
  opencode: 'OpenCode Go',
  'openai-compatible': 'OpenAI 兼容',
};

/**
 * Map from `QuotaCapability` to the chip copy that summarizes what
 * this account can produce. The phrasing here is mirrored by the
 * inline hint that replaces the percentage display for non-`official`
 * accounts (Requirement 5.4). Keep them in sync if either changes.
 */
const CAPABILITY_LABELS: Record<QuotaCapability, string> = {
  official: '官方 Quota',
  health_only: '可用性检查',
  usage_only: '本地用量',
  unsupported: '未支持',
};

/**
 * zh-CN labels for every `ProviderAuthErrorCode` the IPC layer can
 * surface (cpa-quota-import requirements §10). The map is total over
 * the closed union, so adding a new code in `types.ts` is a
 * compile-time error here.
 *
 * Phrasing intentionally stays short and natural (no trailing
 * punctuation, no "错误：" prefix) so it slots into both inline
 * status badges and tooltip text without further reformatting.
 */
export const PROVIDER_AUTH_ERROR_LABELS: Record<
  ProviderAuthErrorCode,
  string
> = {
  auth_missing: '凭据缺失',
  auth_expired: '凭据已过期',
  project_missing: '缺少项目 ID',
  upstream_unauthorized: '上游拒绝授权',
  rate_limited: '上游限流',
  upstream_changed: '上游接口已变更',
  network_error: '网络异常',
  unsupported: '暂未实现 (v1.1 上线)',
  parse_error: '认证文件解析失败',
  unsupported_file: '不支持的文件类型',
  cancelled: '已取消',
  validation: '参数校验失败',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render an epoch-ms timestamp as a short relative string ("3 分钟前",
 * "刚刚", "—" for null). The list updates whenever the parent
 * re-renders after a refresh / delete, so we don't need a ticking
 * clock — the relative copy is good enough for "this row was queried
 * recently" ergonomics without forcing per-second re-renders that
 * the UsagePanel deliberately avoids.
 */
function formatRelativeTime(ts: number | null, now: number): string {
  if (ts === null) return '—';
  const diff = now - ts;
  if (diff < 0) {
    // Clock skew or future timestamp — fall back to absolute time.
    return formatAbsoluteTime(ts);
  }
  const seconds = Math.floor(diff / 1000);
  if (seconds < 30) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatAbsoluteTime(ts);
}

/**
 * Render an epoch-ms timestamp as a short YYYY-MM-DD date. Used as
 * the fallback for timestamps older than ~30 days, where a relative
 * copy stops carrying useful information.
 */
function formatAbsoluteTime(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Identifier tail for the row header — combines the parser-derived
 * `accountId` and `projectId` into a single "@account / project"
 * fragment, dropping any null components so the slot stays clean for
 * accounts that only carry one of the two (e.g. plain API key rows).
 */
function formatIdentifier(
  accountId: string | null,
  projectId: string | null,
): string | null {
  const parts: string[] = [];
  if (accountId !== null && accountId.trim().length > 0) {
    parts.push(`@${accountId}`);
  }
  if (projectId !== null && projectId.trim().length > 0) {
    parts.push(`项目 ${projectId}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The lowercase provider key the `ProviderIcon` registry expects.
 *
 * `ProviderIcon` keys off the `usage_events.provider` strings ("codex",
 * "gemini", "claude", "antigravity", "deepseek", …), not our closed
 * `ProviderId` union. This helper is the bridge — for example
 * `'claude-code'` → `'claude'` so the user sees the Anthropic mark on
 * a Claude Code row.
 */
function providerIconKey(provider: ProviderId): string {
  switch (provider) {
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'gemini-cli':
    case 'gemini-api':
      return 'gemini';
    case 'antigravity':
      return 'antigravity';
    case 'deepseek':
      return 'deepseek';
    case 'xiaomi':
      // No brand SVG ships in `@lobehub/icons-static-svg`; the
      // registry returns null and `ProviderIcon` paints the generic
      // fallback dot. Kept lowercase for consistency.
      return 'xiaomi';
    case 'opencode':
      return 'opencode';
    case 'openai-compatible':
      return 'openai';
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ProviderAuthListProps {
  /** Repository-ordered rows. The component re-sorts by `importedAt`
   *  defensively so callers don't have to remember the contract. */
  readonly rows: ReadonlyArray<ProviderAuthMetadata>;
  readonly onRefresh: (id: string) => void;
  readonly onDelete: (id: string) => void;
  /** Toggle the per-row `enabled` flag. Optional so legacy call
   *  sites that have not been migrated to per-account switches keep
   *  rendering rows with the toggle hidden — the action is visible
   *  only when this callback is supplied. */
  readonly onToggleEnabled?: (id: string, enabled: boolean) => void;
  /** ID of the row whose refresh / delete IPC is currently in flight,
   *  or `null` when no row is busy. Used to disable both the firing
   *  row's buttons (avoid double-fire) and signal "切换中" state. */
  readonly busyId: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProviderAuthList({
  rows,
  onRefresh,
  onDelete,
  onToggleEnabled,
  busyId,
}: ProviderAuthListProps): JSX.Element {
  // Stable ascending sort by `importedAt`, ties broken by `id` for
  // determinism. The repository already returns rows in this order
  // (design.md §ProviderAuthRepository), but sorting here makes the
  // component self-contained and the test fixtures simpler — callers
  // can hand us rows in any order and the rendering stays stable.
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (a.importedAt !== b.importedAt) return a.importedAt - b.importedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [rows]);

  // Snapshot `now` once per render for relative-time formatting so
  // every row in this paint shares the same reference frame.
  const now = Date.now();

  if (sortedRows.length === 0) {
    return (
      <p
        className="provider-auth-list__empty"
        data-testid="provider-auth-list-empty"
      >
        尚未导入任何 AI 账号
      </p>
    );
  }

  return (
    <ul
      className="provider-auth-list"
      data-testid="provider-auth-list"
      aria-label="已导入的 AI 账号"
    >
      {sortedRows.map((row) => (
        <ProviderAuthRow
          key={row.id}
          row={row}
          now={now}
          busy={busyId === row.id}
          onRefresh={onRefresh}
          onDelete={onDelete}
          {...(onToggleEnabled !== undefined
            ? { onToggleEnabled }
            : {})}
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface ProviderAuthRowProps {
  readonly row: ProviderAuthMetadata;
  readonly now: number;
  readonly busy: boolean;
  readonly onRefresh: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onToggleEnabled?: (id: string, enabled: boolean) => void;
}

function ProviderAuthRow({
  row,
  now,
  busy,
  onRefresh,
  onDelete,
  onToggleEnabled,
}: ProviderAuthRowProps): JSX.Element {
  const identifier = formatIdentifier(row.accountId, row.projectId);
  const isExpired = row.lastErrorCode === 'auth_expired';
  // Gemini CLI / Antigravity / Xiaomi rows allow one retry on
  // `auth_expired`:
  //   - Gemini CLI / Antigravity: CPA exports carry ambiguous
  //     timestamp fields that can be misread as token expiry, so
  //     a retry frequently succeeds without user intervention.
  //   - Xiaomi: the cached serviceToken can be invalidated by the
  //     gateway before its nominal TTL; a refresh re-runs the
  //     passToken→serviceToken exchange and recovers transparently.
  const canRetryExpired =
    isExpired &&
    (row.provider === 'gemini-cli' ||
      row.provider === 'antigravity' ||
      row.provider === 'xiaomi');
  const isDisabled = !row.enabled;

  // Refresh is blocked when:
  //   - a sibling IPC is in flight (`busy`),
  //   - the credential expired and cannot be safely retried, or
  //   - the user paused the account (toggle it back on first).
  const refreshDisabled = busy || (isExpired && !canRetryExpired) || isDisabled;

  // Non-`official` capability rows replace the would-be percentage
  // strip with the standard zh-CN explainer copy. Per Requirement
  // 5.4 these accounts must never display percentage-style quota.
  const isPercentless =
    row.quotaCapability === 'health_only' ||
    row.quotaCapability === 'usage_only';

  return (
    <li
      className={
        isDisabled
          ? 'provider-auth-list__row provider-auth-list__row--disabled'
          : 'provider-auth-list__row'
      }
      data-testid={`provider-auth-list-row-${row.id}`}
      data-provider={row.provider}
      data-capability={row.quotaCapability}
      data-error-code={row.lastErrorCode ?? ''}
      data-source={row.source}
      data-enabled={row.enabled ? 'true' : 'false'}
    >
      {/* ── Header: provider chip + label + identifier tail ─── */}
      <header className="provider-auth-list__row-head">
        <span
          className="provider-auth-list__provider-chip"
          aria-label={PROVIDER_LABELS[row.provider]}
        >
          <ProviderIcon provider={providerIconKey(row.provider)} size={16} />
          <span className="provider-auth-list__provider-name">
            {PROVIDER_LABELS[row.provider]}
          </span>
        </span>

        <span className="provider-auth-list__label" title={row.label}>
          {row.label}
        </span>

        {identifier !== null && (
          <span
            className="provider-auth-list__identifier"
            title={identifier}
          >
            {identifier}
          </span>
        )}

        <SourceBadge source={row.source} />
      </header>

      {/* ── Meta row: capability + timestamps + status badge ── */}
      <div className="provider-auth-list__meta">
        <CapabilityChip capability={row.quotaCapability} />

        <span
          className="provider-auth-list__timestamp"
          title="上次校验时间"
        >
          <KeyRound
            size={11}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className="provider-auth-list__timestamp-label">校验</span>
          <span className="provider-auth-list__timestamp-value">
            {formatRelativeTime(row.lastValidatedAt, now)}
          </span>
        </span>

        <span
          className="provider-auth-list__timestamp"
          title="上次刷新时间"
        >
          <Clock
            size={11}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className="provider-auth-list__timestamp-label">刷新</span>
          <span className="provider-auth-list__timestamp-value">
            {formatRelativeTime(row.lastQuotaAt, now)}
          </span>
        </span>

        <StatusBadge errorCode={row.lastErrorCode} disabled={isDisabled} />
      </div>

      {/* ── Capability hint: replaces the percentage strip for
            non-`official` rows (Requirement 5.4 / 6.5). ──── */}
      {isPercentless && (
        <p
          className="provider-auth-list__capability-hint"
          data-testid={`provider-auth-list-row-${row.id}-capability-hint`}
        >
          暂无官方 quota 接口，仅做可用性 / 本地统计
        </p>
      )}

      {/* ── Auth-expired hint: tells the user how to recover.
            Xiaomi accounts authenticate via a cookie pair pasted in
            the API-key form, NOT a CPA export, so the recovery copy
            is provider-specific. The Xiaomi branch is checked
            BEFORE the canRetryExpired generic copy because Xiaomi
            qualifies for retry but its recovery instructions
            (re-paste passToken / userId) are unique. ──── */}
      {isExpired && (
        <p
          className="provider-auth-list__error-hint"
          role="alert"
          data-testid={`provider-auth-list-row-${row.id}-expired-hint`}
        >
          <AlertCircle size={12} strokeWidth={2} aria-hidden="true" />
          {row.provider === 'xiaomi'
            ? '小米 passToken 已被服务端拒绝；请从 account.xiaomi.com 重新复制 passToken 与 userId 后保存'
            : canRetryExpired
              ? '认证状态可能已过期，可先刷新重试；仍失败再从 CPA 重新导出 / 导入'
              : '认证已过期，请从 CPA 重新导出 / 导入'}
          {row.lastErrorMessage !== null && (
            <span className="provider-auth-list__error-detail">
              {' · '}
              {row.lastErrorMessage}
            </span>
          )}
        </p>
      )}

      {/* ── Generic redacted error message for any non-auth-expired
            failure code. The 80-char cap is enforced upstream by the
            IPC schema; we render the value verbatim here. ──── */}
      {!isExpired && row.lastErrorMessage !== null && (
        <p
          className="provider-auth-list__error-hint"
          role="alert"
          data-testid={`provider-auth-list-row-${row.id}-error-hint`}
        >
          <AlertCircle size={12} strokeWidth={2} aria-hidden="true" />
          {row.lastErrorMessage}
        </p>
      )}

      {/* ── Actions: enable toggle + refresh + delete ──── */}
      <div className="provider-auth-list__actions">
        {onToggleEnabled !== undefined && (
          <label
            className="provider-auth-list__toggle"
            data-testid={`provider-auth-list-row-${row.id}-toggle`}
          >
            <input
              type="checkbox"
              className="provider-auth-list__toggle-input"
              checked={row.enabled}
              disabled={busy}
              onChange={(e) => onToggleEnabled(row.id, e.target.checked)}
              aria-label={`${row.enabled ? '停用' : '启用'} ${PROVIDER_LABELS[row.provider]} ${row.label}`}
            />
            <span
              className={
                row.enabled
                  ? 'provider-auth-list__toggle-track provider-auth-list__toggle-track--on'
                  : 'provider-auth-list__toggle-track'
              }
              aria-hidden="true"
            >
              <span className="provider-auth-list__toggle-thumb" />
            </span>
            <span className="provider-auth-list__toggle-label">
              {row.enabled ? '已启用' : '已停用'}
            </span>
          </label>
        )}

        <button
          type="button"
          className="provider-auth-list__btn provider-auth-list__btn--refresh"
          onClick={() => onRefresh(row.id)}
          disabled={refreshDisabled}
          aria-label={`刷新 ${PROVIDER_LABELS[row.provider]} ${row.label}`}
          data-testid={`provider-auth-list-row-${row.id}-refresh`}
          data-busy={busy ? 'true' : 'false'}
        >
          <RefreshCw
            size={13}
            strokeWidth={1.75}
            className={
              busy
                ? 'provider-auth-list__btn-icon provider-auth-list__btn-icon--spin'
                : 'provider-auth-list__btn-icon'
            }
            aria-hidden="true"
          />
          <span>{busy ? '刷新中…' : '刷新'}</span>
        </button>

        <button
          type="button"
          className="provider-auth-list__btn provider-auth-list__btn--delete"
          onClick={() => onDelete(row.id)}
          disabled={busy}
          aria-label={`删除 ${PROVIDER_LABELS[row.provider]} ${row.label}`}
          data-testid={`provider-auth-list-row-${row.id}-delete`}
        >
          <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>删除</span>
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Capability + status pill components
// ---------------------------------------------------------------------------

function CapabilityChip({
  capability,
}: {
  readonly capability: QuotaCapability;
}): JSX.Element {
  return (
    <span
      className="provider-auth-list__capability"
      data-capability={capability}
      title={CAPABILITY_LABELS[capability]}
    >
      {CAPABILITY_LABELS[capability]}
    </span>
  );
}

function StatusBadge({
  errorCode,
  disabled,
}: {
  readonly errorCode: ProviderAuthErrorCode | null;
  readonly disabled: boolean;
}): JSX.Element {
  if (disabled) {
    // Disabled rows take precedence over error codes — the user
    // explicitly paused the account, so there is no need to nag
    // them about a stale lastError.
    return (
      <span
        className="provider-auth-list__status provider-auth-list__status--muted"
        data-status="disabled"
      >
        已停用
      </span>
    );
  }
  if (errorCode === null) {
    return (
      <span
        className="provider-auth-list__status provider-auth-list__status--ok"
        data-status="ok"
      >
        正常
      </span>
    );
  }

  // Any non-null error code paints as a warning pill. We reserve the
  // hard-error tone (red) for `auth_expired`, `auth_missing`,
  // `upstream_unauthorized`, and `parse_error` — codes that block
  // any further interaction without user intervention.
  const isHardError =
    errorCode === 'auth_expired' ||
    errorCode === 'auth_missing' ||
    errorCode === 'upstream_unauthorized' ||
    errorCode === 'parse_error';

  return (
    <span
      className={
        isHardError
          ? 'provider-auth-list__status provider-auth-list__status--error'
          : 'provider-auth-list__status provider-auth-list__status--warn'
      }
      data-status={isHardError ? 'error' : 'warn'}
      data-error-code={errorCode}
    >
      {PROVIDER_AUTH_ERROR_LABELS[errorCode]}
    </span>
  );
}

/**
 * Small chip describing where the row originated. Mirrors the
 * `ProviderAuthMetadata.source` union.
 */
function SourceBadge({
  source,
}: {
  readonly source: ProviderAuthMetadata['source'];
}): JSX.Element {
  const label = source === 'cpa-auth-file' ? 'CPA 文件' : '手动 API Key';
  return (
    <span
      className="provider-auth-list__source"
      data-source={source}
      title={label}
    >
      {label}
    </span>
  );
}
