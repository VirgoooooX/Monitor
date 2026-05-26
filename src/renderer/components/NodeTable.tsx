// NodeTable — region-grouped node card grid for the expanded window.
//
// Each card surfaces: a status dot (green/yellow/red), the node name
// (with active pill / source label), latency, success rate, and a
// 切换 button. Cards lay out in up to 4 columns at the unified
// content width and collapse responsively (see node-table.css).
//
// Beyond the original flat list, nodes are now bucketed by region —
// 香港 / 台湾 / 日本 / 美国 / 其他 — so a 48-node group like the one
// in the screenshot stops looking like one undifferentiated wall of
// chips. The bucket is derived heuristically from the node name and
// `source` label using a single matcher table; nodes that match no
// rule fall through to "其他".
//
// The component name and props are preserved from the previous
// implementation; only the markup and visual treatment change. IPC
// behaviour, optimistic UI, and the toast/confirm flow are
// identical, so consumers in `App.tsx` continue to work unchanged.
//
// Switching workflow:
//   1. If `switchConfirmEnabled`, show a confirm dialog first.
//   2. Set the firing card to `switching` state (optimistic UI).
//   3. Call `window.desktop.switchNode({ groupName, nodeName })`.
//   4. On `ok:true` → update current node.
//   5. On `ok:false` → show error toast, roll back to `actualCurrent`.
//
// References:
//   • design.md §Manual Node Switch with Verification
//   • design.md §Window Strategy
//   • PLAN.md §UI Implementation Guide §节点表 §切换前确认

import { useCallback, useMemo, useState } from 'react';

import type { NodeView } from '../lib/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NodeTableProps {
  readonly nodes: NodeView[];
  readonly currentNode: string | null;
  readonly groupName: string | null;
  readonly switchConfirmEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface RowState {
  /** Node currently being switched to (optimistic). */
  switchingNode: string | null;
  /** Toast message shown on failure. */
  toast: string | null;
}

// ---------------------------------------------------------------------------
// Helpers — formatting
// ---------------------------------------------------------------------------

function formatDelay(ms: number | null): string {
  if (ms === null) return '—';
  return `${Math.round(ms)} ms`;
}

function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  // rate is 0..1 over last 10 samples → display as "N/10"
  return `${Math.round(rate * 10)}/10`;
}

// ---------------------------------------------------------------------------
// Helpers — node status tone (green / yellow / red / unknown)
// ---------------------------------------------------------------------------
//
// Tone derivation mirrors the dashboard's `node_slow` rule so the dot
// the user sees here is consistent with the rest of the UI:
//
//   • `ok`    — last probe succeeded AND avg delay < 300 ms
//                AND success rate >= 0.8
//   • `warn`  — has data but is slow OR partially failing
//                (delay >= 300 ms OR success rate in [0.5, 0.8))
//   • `bad`   — last probe failed OR success rate < 0.5
//   • `unknown` — no data yet (delay null AND rate null)

type NodeTone = 'ok' | 'warn' | 'bad' | 'unknown';

function deriveTone(node: NodeView): NodeTone {
  const { lastDelayMs, successRate } = node;

  if (lastDelayMs === null && successRate === null) {
    return 'unknown';
  }

  // Rate is the most reliable signal once we have samples.
  if (successRate !== null) {
    if (successRate < 0.5) return 'bad';
    if (successRate < 0.8) return 'warn';
  }

  if (lastDelayMs !== null) {
    if (lastDelayMs >= 1500) return 'bad';
    if (lastDelayMs >= 300) return 'warn';
  }

  return 'ok';
}

// ---------------------------------------------------------------------------
// Helpers — region bucketing
// ---------------------------------------------------------------------------
//
// Buckets nodes into a small fixed set of regions based on substring
// matches against the node name and source label. The matcher table
// is intentionally short and exhaustive on the high-level categories
// the user asked for; everything else falls through to "其他".
//
// Each bucket carries a stable display order so the rendered
// sections always come out HK → TW → JP → US → 其他 regardless of
// the upstream node ordering. Within a bucket nodes preserve their
// original order from the IPC payload.

interface RegionBucket {
  readonly key: string;
  readonly label: string;
  /** Lower order = rendered first. */
  readonly order: number;
  /** Substrings (lowercased) that classify a node into this bucket. */
  readonly tokens: readonly string[];
}

const REGION_BUCKETS: readonly RegionBucket[] = [
  {
    key: 'hk',
    label: '香港',
    order: 1,
    tokens: ['香港', 'hong kong', 'hongkong', 'hk'],
  },
  {
    key: 'tw',
    label: '台湾',
    order: 2,
    tokens: ['台湾', '臺灣', 'taiwan', 'tw'],
  },
  {
    key: 'jp',
    label: '日本',
    order: 3,
    tokens: ['日本', 'japan', 'jp', 'tokyo', 'osaka'],
  },
  {
    key: 'us',
    label: '美国',
    order: 4,
    tokens: ['美国', '美國', 'america', 'united states', 'usa', 'us', 'um'],
  },
];

const OTHER_BUCKET: RegionBucket = {
  key: 'other',
  label: '其他',
  order: 99,
  tokens: [],
};

/**
 * Classify a node into one of the predefined region buckets.
 *
 * Match strategy: scan name + source against each bucket's token
 * list in declaration order; first hit wins. The ASCII tokens are
 * matched as **whole words** (regex `\btoken\b`) so a node literally
 * named "美国A01" doesn't accidentally match "us" inside a longer
 * word — but is still picked up by the standalone `美国` token.
 * Chinese tokens are matched as plain substrings since CJK has no
 * word boundaries to anchor against.
 */
function classifyNode(node: NodeView): RegionBucket {
  const haystack = `${node.name} ${node.source ?? ''}`.toLowerCase();

  for (const bucket of REGION_BUCKETS) {
    for (const token of bucket.tokens) {
      const t = token.toLowerCase();
      // CJK characters never match \w in JS regex, so we can safely
      // pick the boundary strategy by inspecting the token itself.
      const isAscii = /^[a-z\s]+$/.test(t);
      if (isAscii) {
        const re = new RegExp(`\\b${t.replace(/\s+/g, '\\s+')}\\b`);
        if (re.test(haystack)) return bucket;
      } else if (haystack.includes(t)) {
        return bucket;
      }
    }
  }
  return OTHER_BUCKET;
}

interface RegionSection {
  readonly bucket: RegionBucket;
  readonly nodes: NodeView[];
}

/**
 * Group an array of nodes into ordered region sections. Empty
 * sections are dropped so a deployment without any HK nodes does
 * not render an empty "香港" header.
 */
function groupByRegion(nodes: NodeView[]): RegionSection[] {
  const groups = new Map<string, RegionSection>();

  for (const node of nodes) {
    const bucket = classifyNode(node);
    let section = groups.get(bucket.key);
    if (!section) {
      section = { bucket, nodes: [] };
      groups.set(bucket.key, section);
    }
    section.nodes.push(node);
  }

  return Array.from(groups.values()).sort(
    (a, b) => a.bucket.order - b.bucket.order,
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeTable({
  nodes,
  currentNode,
  groupName,
  switchConfirmEnabled,
}: NodeTableProps): JSX.Element {
  const [rowState, setRowState] = useState<RowState>({
    switchingNode: null,
    toast: null,
  });

  // Track the optimistic current for highlighting during a switch.
  const [optimisticCurrent, setOptimisticCurrent] = useState<string | null>(
    null,
  );

  const effectiveCurrent = optimisticCurrent ?? currentNode;

  // Region grouping is pure with respect to `nodes`; recompute when
  // the IPC pushes a new payload.
  const sections = useMemo(() => groupByRegion(nodes), [nodes]);

  const dismissToast = useCallback(() => {
    setRowState((prev) => ({ ...prev, toast: null }));
  }, []);

  const handleSwitch = useCallback(
    async (nodeName: string) => {
      if (!groupName) return;

      // Confirm dialog if enabled.
      if (switchConfirmEnabled) {
        // Using native confirm for simplicity; matches design §切换前确认.
        // eslint-disable-next-line no-alert
        const confirmed = window.confirm(
          `确认切换到节点「${nodeName}」？`,
        );
        if (!confirmed) return;
      }

      // Optimistic UI.
      setRowState({ switchingNode: nodeName, toast: null });
      setOptimisticCurrent(nodeName);

      const desktop = window.desktop;
      if (!desktop) {
        setRowState({ switchingNode: null, toast: 'desktop bridge 不可用' });
        setOptimisticCurrent(null);
        return;
      }

      try {
        const result = await desktop.switchNode({ groupName, nodeName });

        if (result.ok) {
          // Success — keep optimistic current (matches verified state).
          setRowState({ switchingNode: null, toast: null });
          setOptimisticCurrent(result.newCurrent);
        } else {
          // Failure — roll back.
          const msg =
            result.error?.message ?? '切换失败';
          setRowState({ switchingNode: null, toast: msg });
          setOptimisticCurrent(result.actualCurrent);
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : '切换发生未知错误';
        setRowState({ switchingNode: null, toast: msg });
        setOptimisticCurrent(null);
      }
    },
    [groupName, switchConfirmEnabled],
  );

  const renderCard = (node: NodeView): JSX.Element => {
    const isActive = effectiveCurrent === node.name;
    const isSwitching = rowState.switchingNode === node.name;
    const tone = deriveTone(node);

    return (
      <article
        key={node.name}
        role="listitem"
        className={[
          'node-table__card',
          isActive ? 'node-table__card--active' : '',
          isSwitching ? 'node-table__card--switching' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-tone={tone}
        data-testid={`node-row-${node.name}`}
      >
        <div className="node-table__card-head">
          <span
            className={`node-table__card-status node-table__card-status--${tone}`}
            aria-label={`状态 ${tone}`}
            title={`状态：${tone}`}
          />
          {node.source && (
            <span className="node-table__card-source">
              {node.source}
            </span>
          )}
          <span className="node-table__card-name" title={node.name}>
            {node.name}
          </span>
          {isActive && (
            <span className="node-table__card-active-pill">当前</span>
          )}
        </div>

        <div className="node-table__card-foot">
          <span
            className="node-table__card-metric"
            title={`延迟 ${formatDelay(node.lastDelayMs)}`}
          >
            {formatDelay(node.lastDelayMs)}
          </span>
          <span
            className="node-table__card-metric-sep"
            aria-hidden="true"
          >
            ·
          </span>
          <span
            className="node-table__card-metric"
            title={`成功率 ${formatRate(node.successRate)}`}
          >
            {formatRate(node.successRate)}
          </span>
          <button
            className="node-table__switch-btn"
            disabled={isActive || isSwitching || !groupName}
            onClick={() => handleSwitch(node.name)}
            type="button"
          >
            {isSwitching ? '切换中…' : '切换'}
          </button>
        </div>
      </article>
    );
  };

  return (
    <div className="node-table" data-testid="node-table">
      {/* Toast overlay */}
      {rowState.toast && (
        <div
          className="node-table__toast"
          data-testid="node-table-toast"
          role="alert"
          onClick={dismissToast}
        >
          {rowState.toast}
        </div>
      )}

      {nodes.length === 0 ? (
        <div className="node-table__empty">暂无节点数据</div>
      ) : (
        <div className="node-table__sections">
          {sections.map((section) => (
            <section
              key={section.bucket.key}
              className="node-table__section"
              data-region={section.bucket.key}
              data-testid={`node-region-${section.bucket.key}`}
            >
              <header className="node-table__section-head">
                <h3 className="node-table__section-title">
                  {section.bucket.label}
                </h3>
                <span className="node-table__section-count">
                  {section.nodes.length}
                </span>
              </header>

              <div className="node-table__grid" role="list">
                {section.nodes.map(renderCard)}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
