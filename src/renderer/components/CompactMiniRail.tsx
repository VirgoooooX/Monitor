// CompactMiniRail — ultra-compact vertical status view.
//
// The rail keeps the floating window useful when screen space is tight:
// network health first, then one icon per quota provider with a conic
// progress ring. Codex prefers its 5-hour window; Gemini-family
// providers use an average because they usually expose model buckets.

import type { DashboardState, QuotaSnapshot, QuotaWindow } from '../lib/types';
import type { CSSProperties } from 'react';
import { quotaWindowDisplayName } from '../lib/quota-display';
import { ProviderIcon } from './ProviderIcon';
import { useQuotaStatus } from './QuotaStrip';

interface ProviderQuotaBadge {
  provider: string;
  percent: number | null;
  label: string;
}

const PROVIDER_ORDER = [
  'codex',
  'claude-code',
  'gemini-cli',
  'gemini-api',
  'antigravity',
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
  if (values.length === 0) {
    return null;
  }
  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function usableWindows(snapshot: QuotaSnapshot): QuotaWindow[] {
  return snapshot.windows.filter((window) => (
    quotaWindowDisplayName(window.name, snapshot.provider) !== null &&
    window.percentLeft !== null
  ));
}

function snapshotPercent(snapshot: QuotaSnapshot): number | null {
  const windows = usableWindows(snapshot);
  if (snapshot.provider === 'codex') {
    const fiveHour = windows.find((window) => (
      quotaWindowDisplayName(window.name, snapshot.provider) === '5 小时限额'
    ));
    if (fiveHour?.percentLeft !== null && fiveHour?.percentLeft !== undefined) {
      return clampPercent(fiveHour.percentLeft);
    }
  }

  return average(windows.flatMap((window) => (
    window.percentLeft === null ? [] : [window.percentLeft]
  )));
}

function providerDisplayName(provider: string, snapshots: QuotaSnapshot[]): string {
  const label = snapshots.find((snapshot) => snapshot.accountLabel)?.accountLabel;
  if (label) {
    return label;
  }
  switch (provider) {
    case 'codex': return 'Codex';
    case 'claude-code': return 'Claude Code';
    case 'gemini-cli': return 'Gemini';
    case 'gemini-api': return 'Gemini API';
    case 'antigravity': return 'Antigravity';
    case 'opencode': return 'OpenCode';
    case 'deepseek': return 'DeepSeek';
    case 'xiaomi':
    case 'xiaomi-cloud':
    case 'xiaomi-mimo': return '小米';
    default: return provider;
  }
}

function buildProviderBadges(snapshots: QuotaSnapshot[]): ProviderQuotaBadge[] {
  const byProvider = new Map<string, QuotaSnapshot[]>();
  for (const snapshot of snapshots) {
    const existing = byProvider.get(snapshot.provider);
    if (existing) {
      existing.push(snapshot);
    } else {
      byProvider.set(snapshot.provider, [snapshot]);
    }
  }

  return [...byProvider.entries()]
    .map(([provider, providerSnapshots]) => {
      const values = providerSnapshots.flatMap((snapshot) => {
        const percent = snapshotPercent(snapshot);
        return percent === null ? [] : [percent];
      });
      const percent = average(values);
      return {
        provider,
        percent,
        label: providerDisplayName(provider, providerSnapshots),
      };
    })
    .filter((badge) => badge.percent !== null)
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
  const quotaStatus = useQuotaStatus();
  const badges = quotaStatus ? buildProviderBadges(quotaStatus.snapshots) : [];
  const latencyText = state.currentNode.avgLatencyMs === null
    ? ''
    : ` · ${Math.round(state.currentNode.avgLatencyMs)}ms`;

  return (
    <div className="compact-mini-rail" data-testid="compact-mini-rail">
      <span
        className="compact-mini-rail__network"
        data-tone={networkTone(state.status)}
        title={`${state.statusLabel}${latencyText}`}
        aria-label={`${state.statusLabel}${latencyText}`}
      />

      <span className="compact-mini-rail__divider" aria-hidden="true" />

      {badges.map((badge) => {
        const percent = badge.percent;
        const ringPercent = percent ?? 0;
        const title = percent === null
          ? `${badge.label} · 额度未知`
          : `${badge.label} · ${percent}%`;

        return (
          <span
            key={badge.provider}
            className="compact-mini-rail__provider"
            data-tone={quotaTone(percent)}
            style={{ '--quota-percent': `${ringPercent}%` } as CSSProperties}
            title={title}
            aria-label={title}
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
