// CompactMiniRail — ultra-compact vertical status view.
//
// The rail keeps the floating window useful when screen space is
// tight: network health first, then one icon per quota provider with
// a conic progress ring.
//
// ── Why the badge shows "effective 5h capacity" instead of a raw % ──
//
// The painful case that drove this design: Codex / Claude Code /
// OpenCode each expose TWO AND-coupled time windows — a short
// rolling window (5h) and a slower weekly cap. They can disagree
// dramatically: an account might have 5h=100% but weekly=1%, which
// looks healthy in any dashboard that cherry-picks the 5h window
// (the previous behaviour) but is *not* actually usable — the
// weekly cap blocks requests long before the 5h budget gets spent.
//
// We tried four visual approaches first (dual concentric rings,
// glassy LED corner dot, halo, top-edge wedge) and all of them
// failed the eyeball test in 32×32. The fix was therefore to stop
// trying to surface two numbers and instead derive a single
// "effective" percentage that reflects what the user can *actually*
// use right now.
//
// Formula:
//   weekly_as_5h = min(100, weekly% / WEEKLY_PER_5H[provider])
//   effective    = min(5h%, weekly_as_5h)
//
// `WEEKLY_PER_5H` is the fraction of the weekly cap that one full
// 5h window consumes (provider-specific, see constants below). When
// the weekly cap is wide open, weekly_as_5h saturates at 100 and
// effective collapses to 5h%. When weekly is tight, weekly_as_5h
// starts pulling effective downward — which is the honest signal.
//
// The displayed percentage is therefore *not* a literal window
// reading, it's the answer to "how much of a fresh 5h window can I
// actually use right now". The tooltip still surfaces both raw
// numbers (`5h X% · 周 Y%`) so users can reconcile.
//
// Other providers (antigravity, gemini-cli, kiro-ide, deepseek,
// xiaomi, …) keep the existing average semantics. Their windows
// are either model-pool replacements (OR-coupled) or single-window
// credits, so the AND-coupled distortion does not apply.

import type { DashboardState, HealthStatus, QuotaSnapshot, QuotaWindow } from '../lib/types';
import type { CSSProperties } from 'react';
import type { TranslationKey, Translator } from '../../i18n';
import { quotaWindowDisplayName } from '../lib/quota-display';
import { useT } from '../lib/i18n';
import { ProviderIcon } from './ProviderIcon';
import { useQuotaStatus } from './QuotaStrip';

// Closed Health_Status enum used to guard the runtime cast into the
// `dashboard.health.*` Translation_Key namespace. Mirrors the set in
// `StatusHero.tsx` (task 13.1) — both surfaces derive the visible
// status label from `t('dashboard.health.' + status)` so a future
// schema relaxation, replay artefact, or stale IPC payload that
// surfaces an unknown `status` token cannot construct an
// out-of-catalog key. Out-of-set values fall back to `'healthy'`
// per Requirement 6.8 so the tooltip / aria-label still resolves to
// a real catalog string instead of leaking the raw enum tag.
const SUPPORTED_HEALTH_STATUSES = new Set<HealthStatus>([
  'healthy',
  'node_slow',
  'node_down',
  'openclash_unreachable',
  'home_down',
  'partial_outage',
]);

interface ProviderQuotaBadge {
  readonly provider: string;
  readonly label: string;
  /** Effective ring percentage 0..100. Drives both fill and tone. */
  readonly effective: number | null;
  /** Tooltip / aria text — exposes the raw windows when applicable. */
  readonly title: string;
}/**
 * Fraction of the weekly cap that one full 5h window consumes for
 * each AND-coupled provider. Sourced from public data points (rate
 * cards, community telemetry, vendor announcements). Numbers are
 * approximate medians — the goal is "which value is the binding
 * constraint right now", not a precise spend prediction.
 *
 * Codex (ChatGPT Plus / Pro)
 *   • Community telemetry (OpenAI forum threads, GPT-5.5 era):
 *     "single prompt costs ~25% of 5h and ~7% of weekly", which
 *     implies a full 5h ≈ 28% of the weekly budget.
 *   • Apidog comparison: Plus ≈ 30–150 messages / 5h, ≈ 3000 / week,
 *     consistent with 5h being a low double-digit fraction of weekly.
 *   • Conservative midpoint: 0.28.
 *
 * Claude Code (Anthropic Pro / Max)
 *   • Anthropic emails / official numbers: Max 5x → 140–280 hours of
 *     Sonnet 4 per week; one 5h window ≈ 5–10 hours of work.
 *     Implies 5h ≈ 3.5–7% of the weekly cap.
 *   • Pro plan community heuristic: "a heavy 5h session ≈ 10–20%
 *     of weekly".
 *   • Median across plan tiers: 0.10.
 *
 * OpenCode Go
 *   • Plan is dollar-based and the official numbers are exact:
 *     5h cap = $12, weekly cap = $30 → 5h is 12/30 = 0.40 of weekly.
 *   • This is the highest ratio of the three; the weekly cap starts
 *     pinching short windows much earlier.
 */
const WEEKLY_PER_5H: Readonly<Record<string, number>> = {
  codex: 0.28,
  'claude-code': 0.10,
  opencode: 0.40,
};

const PROVIDER_ORDER = [
  'codex',
  'claude-code',
  'gemini-cli',
  'gemini-api',
  'antigravity',
  'kiro-ide',
  'deepseek',
  'xiaomi',
  'opencode',
];

function providerRank(provider: string): number {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? 999 : index;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function usableWindows(snapshot: QuotaSnapshot): QuotaWindow[] {
  return snapshot.windows.filter((window) => (
    quotaWindowDisplayName(window.name, snapshot.provider) !== null &&
    window.percentLeft !== null
  ));
}

interface SnapshotResult {
  /** Effective % to render on the ring. */
  readonly effective: number | null;
  /** Raw 5h reading (only present for AND-coupled providers). */
  readonly fiveH: number | null;
  /** Raw weekly reading (only present for AND-coupled providers). */
  readonly weekly: number | null;
  /** True when the provider is one of codex / claude-code / opencode. */
  readonly andCoupled: boolean;
}

/**
 * Compute the per-snapshot effective percentage. For AND-coupled
 * providers (codex / claude-code / opencode) this folds the weekly
 * cap into a 5h-equivalent budget; for everything else it keeps the
 * previous "average across usable windows" semantics, which is a
 * no-op for single-window providers and behaves sensibly for
 * model-pool replacements (gemini-cli, antigravity).
 */
function snapshotEffective(snapshot: QuotaSnapshot): SnapshotResult {
  const windows = usableWindows(snapshot);
  const ratio = WEEKLY_PER_5H[snapshot.provider];

  if (ratio !== undefined) {
    // AND-coupled provider: pull out the 5h and weekly windows by
    // their canonical display names so collector renames don't
    // silently swap the inputs.
    const fiveHWindow = windows.find((w) => {
      const name = quotaWindowDisplayName(w.name, snapshot.provider);
      return name === '5 小时限额' || name === '滚动用量';
    });
    const weeklyWindow = windows.find((w) => {
      const name = quotaWindowDisplayName(w.name, snapshot.provider);
      return name === '周限额' || name === '每周用量';
    });

    const fiveH = fiveHWindow?.percentLeft ?? null;
    const weekly = weeklyWindow?.percentLeft ?? null;

    // Single-window degradation: if one input is missing the formula
    // reduces to "trust the side we have" so the badge still appears
    // instead of silently disappearing.
    if (fiveH === null && weekly === null) {
      return { effective: null, fiveH: null, weekly: null, andCoupled: true };
    }
    if (fiveH === null) {
      return {
        effective: clampPercent(Math.min(100, (weekly as number) / ratio)),
        fiveH: null,
        weekly,
        andCoupled: true,
      };
    }
    if (weekly === null) {
      return {
        effective: clampPercent(fiveH),
        fiveH,
        weekly: null,
        andCoupled: true,
      };
    }

    // Both windows present — the formula applies in full.
    const weeklyAs5h = Math.min(100, weekly / ratio);
    const effective = clampPercent(Math.min(fiveH, weeklyAs5h));
    return { effective, fiveH, weekly, andCoupled: true };
  }

  // Non-AND-coupled provider: keep the existing averaging semantics.
  const values = windows.flatMap((w) => (w.percentLeft === null ? [] : [w.percentLeft]));
  return {
    effective: average(values),
    fiveH: null,
    weekly: null,
    andCoupled: false,
  };
}

function providerDisplayName(provider: string, snapshots: QuotaSnapshot[]): string {
  const label = snapshots.find((snapshot) => snapshot.accountLabel)?.accountLabel;
  if (label) return label;
  switch (provider) {
    case 'codex': return 'Codex';
    case 'claude-code': return 'Claude Code';
    case 'gemini-cli': return 'Gemini';
    case 'gemini-api': return 'Gemini API';
    case 'antigravity': return 'Antigravity';
    case 'kiro-ide': return 'Kiro';
    case 'opencode': return 'OpenCode';
    case 'deepseek': return 'DeepSeek';
    case 'xiaomi':
    case 'xiaomi-cloud':
    case 'xiaomi-mimo': return 'Xiaomi';
    default: return provider;
  }
}

/**
 * Build the tooltip / aria-label. AND-coupled providers expose the
 * raw 5h and weekly numbers so the user can reconcile against the
 * derived effective percentage; everything else falls back to the
 * single percentage.
 */
function buildBadgeTitle(
  t: Translator,
  label: string,
  result: SnapshotResult,
): string {
  if (result.andCoupled) {
    if (result.fiveH === null && result.weekly === null) {
      return t('compactMiniRail.quotaUnknown', { label });
    }
    const segs: string[] = [];
    if (result.fiveH !== null) {
      segs.push(t('compactMiniRail.quotaPair.fiveH', { pct: Math.round(result.fiveH) }));
    }
    if (result.weekly !== null) {
      segs.push(t('compactMiniRail.quotaPair.weekly', { pct: Math.round(result.weekly) }));
    }
    if (result.effective !== null) {
      // Surface the effective number too so users know what the ring
      // is reflecting; otherwise "5h 100% / weekly 1%" with a 3% red
      // ring looks like a UI bug.
      segs.push(t('compactMiniRail.quotaPair.effective', { pct: result.effective }));
    }
    return `${label} · ${segs.join(' · ')}`;
  }
  if (result.effective === null) return t('compactMiniRail.quotaUnknown', { label });
  return t('compactMiniRail.quotaSingle', { label, pct: result.effective });
}

function buildProviderBadges(
  t: Translator,
  snapshots: QuotaSnapshot[],
): ProviderQuotaBadge[] {
  const byProvider = new Map<string, QuotaSnapshot[]>();
  for (const snapshot of snapshots) {
    const existing = byProvider.get(snapshot.provider);
    if (existing) existing.push(snapshot);
    else byProvider.set(snapshot.provider, [snapshot]);
  }

  return [...byProvider.entries()]
    .map(([provider, providerSnapshots]) => {
      // Aggregate per-snapshot results so a provider with multiple
      // accounts collapses to a single badge. The effective value is
      // averaged (consistent with the previous multi-account merge);
      // raw 5h / weekly readings are also averaged for the tooltip
      // so it stays representative.
      const effs: number[] = [];
      const fives: number[] = [];
      const weeks: number[] = [];
      let andCoupled = false;
      for (const snapshot of providerSnapshots) {
        const r = snapshotEffective(snapshot);
        andCoupled = andCoupled || r.andCoupled;
        if (r.effective !== null) effs.push(r.effective);
        if (r.fiveH !== null) fives.push(r.fiveH);
        if (r.weekly !== null) weeks.push(r.weekly);
      }
      const merged: SnapshotResult = {
        effective: average(effs),
        fiveH: fives.length === 0 ? null : average(fives),
        weekly: weeks.length === 0 ? null : average(weeks),
        andCoupled,
      };
      const label = providerDisplayName(provider, providerSnapshots);
      return {
        provider,
        label,
        effective: merged.effective,
        title: buildBadgeTitle(t, label, merged),
      } satisfies ProviderQuotaBadge;
    })
    .filter((badge) => badge.effective !== null)
    .sort((a, b) => {
      const rank = providerRank(a.provider) - providerRank(b.provider);
      if (rank !== 0) return rank;
      return a.label.localeCompare(b.label, 'zh-CN');
    });
}

function quotaTone(percent: number | null): 'unknown' | 'critical' | 'warn' | 'ok' {
  if (percent === null) return 'unknown';
  if (percent <= 20) return 'critical';
  if (percent <= 50) return 'warn';
  return 'ok';
}

function networkTone(status: DashboardState['status']): 'bad' | 'warn' | 'ok' {
  if (
    status === 'home_down' ||
    status === 'openclash_unreachable' ||
    status === 'node_down'
  ) {
    return 'bad';
  }
  if (status === 'partial_outage' || status === 'node_slow') {
    return 'warn';
  }
  return 'ok';
}

export function CompactMiniRail({
  state,
}: {
  readonly state: DashboardState;
}): JSX.Element {
  const t = useT();
  const quotaStatus = useQuotaStatus();
  const badges = quotaStatus ? buildProviderBadges(t, quotaStatus.snapshots) : [];
  const latencyText = state.currentNode.avgLatencyMs === null
    ? ''
    : ` · ${Math.round(state.currentNode.avgLatencyMs)}ms`;

  // Pivot: derive the visible status label from the i18n catalog
  // instead of `state.statusLabel`, which is soft-deprecated and
  // ignored renderer-side (Requirements 6.2, 6.3). Guard the
  // narrowing so any out-of-set token coming over IPC collapses to
  // `'healthy'` before we build the Translation_Key (Requirement 6.8).
  const safeStatus: HealthStatus =
    typeof state.status === 'string' &&
    SUPPORTED_HEALTH_STATUSES.has(state.status as HealthStatus)
      ? (state.status as HealthStatus)
      : 'healthy';
  const statusLabel = t(('dashboard.health.' + safeStatus) as TranslationKey);

  return (
    <div className="compact-mini-rail" data-testid="compact-mini-rail">
      <span
        className="compact-mini-rail__network"
        data-tone={networkTone(state.status)}
        title={`${statusLabel}${latencyText}`}
        aria-label={`${statusLabel}${latencyText}`}
      />

      <span className="compact-mini-rail__divider" aria-hidden="true" />

      {badges.map((badge) => {
        const fillPercent = badge.effective ?? 0;
        return (
          <span
            key={badge.provider}
            className="compact-mini-rail__provider"
            data-tone={quotaTone(badge.effective)}
            style={{ '--quota-percent': `${fillPercent}%` } as CSSProperties}
            title={badge.title}
            aria-label={badge.title}
          >
            <span className="compact-mini-rail__icon">
              <ProviderIcon provider={badge.provider} size={21} />
            </span>
          </span>
        );
      })}
    </div>
  );
}
