// NodeTable — per-node row table for the expanded window.
//
// Each row displays: node name (truncated + tooltip), source label,
// last delay (ms), success rate badge (e.g. "8/10"), and a 切换 button.
//
// Switching workflow:
//   1. If `switchConfirmEnabled`, show a confirm dialog first.
//   2. Set row to `switching` state (optimistic UI).
//   3. Call `window.desktop.switchNode({ groupName, nodeName })`.
//   4. On `ok:true` → update current node.
//   5. On `ok:false` → show error toast, roll back to `actualCurrent`.
//
// References:
//   • design.md §Manual Node Switch with Verification
//   • design.md §Window Strategy
//   • PLAN.md §UI Implementation Guide §节点表 §切换前确认

import { useCallback, useState } from 'react';

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
// Helpers
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

      <table className="node-table__table">
        <thead>
          <tr>
            <th className="node-table__th">节点</th>
            <th className="node-table__th">来源</th>
            <th className="node-table__th">延迟</th>
            <th className="node-table__th">成功率</th>
            <th className="node-table__th">操作</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => {
            const isActive = effectiveCurrent === node.name;
            const isSwitching = rowState.switchingNode === node.name;

            return (
              <tr
                key={node.name}
                className={[
                  'node-table__row',
                  isActive ? 'node-table__row--active' : '',
                  isSwitching ? 'node-table__row--switching' : '',
                ].join(' ')}
                data-testid={`node-row-${node.name}`}
              >
                <td
                  className="node-table__cell node-table__cell--name"
                  title={node.name}
                >
                  {node.name}
                </td>
                <td className="node-table__cell node-table__cell--source">
                  {node.source ?? '—'}
                </td>
                <td className="node-table__cell node-table__cell--delay">
                  {formatDelay(node.lastDelayMs)}
                </td>
                <td className="node-table__cell node-table__cell--rate">
                  <span className="node-table__badge">
                    {formatRate(node.successRate)}
                  </span>
                </td>
                <td className="node-table__cell node-table__cell--action">
                  <button
                    className="node-table__switch-btn"
                    disabled={isActive || isSwitching || !groupName}
                    onClick={() => handleSwitch(node.name)}
                    type="button"
                  >
                    {isSwitching ? '切换中…' : '切换'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {nodes.length === 0 && (
        <div className="node-table__empty">暂无节点数据</div>
      )}
    </div>
  );
}
