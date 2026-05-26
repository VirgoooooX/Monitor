// @vitest-environment jsdom
//
// Feature: network-quick-actions, Property 3 (UI half): Exclusive switch invariant.
// Validates Requirements 3.7, 5.3.
//
// Component tests for `QuickNodeCard` (network-quick-actions task
// 15.9). The card is the sole UI surface for primary-group node
// switching on the expanded window, so the disablement matrix below
// is the user-visible projection of the lock arbitration enforced in
// the main process by `switch.lock.ts`. The IPC half of Property 3
// lives in `switch.lock.test.ts`; this file pins the renderer side
// of the same invariant:
//
//   • A `'config'` lock disables every candidate button (a kernel
//     reload is in flight; firing a node switch would race the
//     restart — Requirement 5.3).
//   • A `'node'` lock matching the primary group's name disables
//     every candidate button (Requirement 3.7 + 9.2).
//   • A `'node'` lock for a *different* group leaves the card alone
//     (Requirement 9.3 cross-group concurrency).
//   • While a same-card switch is in flight, sibling candidate
//     buttons are locally disabled until the IPC settles
//     (Requirement 3.7), even before the parent observes a new
//     `switchInProgress` push.
//   • Click → IPC: a single click fires `window.desktop.switchNode`
//     exactly once with the expected `{ groupName, nodeName }`
//     payload, the contract Quick_Node_Card relies on the existing
//     `SwitchNodeService` for.
//   • Empty candidates → render the "暂无可推荐节点" placeholder
//     and zero buttons (Requirement 3.4).
//
// The fake bridge replaces `window.desktop.switchNode` with a
// `vi.fn()` so we can assert call counts and arguments. `switchNode`
// is the only channel exercised here; the rest of `DesktopApi` is
// not stubbed because the card never calls it directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { QuickNodeCard } from './QuickNodeCard';
import type {
  NetworkQuickActions,
  QuickNodeCandidate,
  SwitchNodeInput,
  SwitchNodeResult,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a `QuickNodeCandidate` with sensible defaults so individual
 * cases only have to spell out the slice they care about.
 */
function candidate(
  nodeName: string,
  overrides: Partial<QuickNodeCandidate> = {},
): QuickNodeCandidate {
  return {
    nodeName,
    avgLatencyMs: 100,
    okSamples: 10,
    lastOk: true,
    ...overrides,
  };
}

/**
 * Build a `NetworkQuickActions['primaryGroup']` slice with the given
 * name, current node, and candidate list. Defaults give a stable
 * baseline for the disablement matrix (a real group name with three
 * ranked candidates).
 */
function primaryGroup(
  overrides: Partial<NetworkQuickActions['primaryGroup']> = {},
): NetworkQuickActions['primaryGroup'] {
  return {
    name: 'PrimaryGroup',
    currentNode: 'CurrentNode',
    candidates: [
      candidate('NodeA', { avgLatencyMs: 80 }),
      candidate('NodeB', { avgLatencyMs: 120 }),
      candidate('NodeC', { avgLatencyMs: 160 }),
    ],
    ...overrides,
  };
}

/**
 * Install a fake `window.desktop` bridge with a `switchNode` mock.
 * The optional `switchNodeImpl` lets tests control the resolution
 * timing — for example, returning a never-resolving promise to keep
 * the card's local-switching state pinned for assertions.
 *
 * Other `DesktopApi` methods are intentionally absent: the card's
 * code path never reaches them, and any accidental coupling will
 * surface as a runtime "not a function" failure.
 */
function installDesktopBridge(
  switchNodeImpl?: (input: SwitchNodeInput) => Promise<SwitchNodeResult>,
) {
  const defaultImpl = async (
    input: SwitchNodeInput,
  ): Promise<SwitchNodeResult> => ({
    ok: true,
    newCurrent: input.nodeName,
    verifiedAt: Date.now(),
  });

  const switchNode = vi.fn<[SwitchNodeInput], Promise<SwitchNodeResult>>(
    switchNodeImpl ?? defaultImpl,
  );

  (window as unknown as { desktop: unknown }).desktop = { switchNode };

  return { switchNode };
}

beforeEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

// ===========================================================================
// Property 3 (UI half) — `switchInProgress.kind === 'config'`
// ===========================================================================

describe('QuickNodeCard — Property 3 (UI half): config lock disables every button', () => {
  it('disables every candidate button while a config switch is in flight', () => {
    installDesktopBridge();

    render(
      <QuickNodeCard
        primaryGroup={primaryGroup()}
        switchInProgress={{ kind: 'config' }}
      />,
    );

    // Every candidate must be disabled — none is allowed to fire a
    // node switch while the kernel is reloading.
    const btnA = screen.getByTestId('quick-node-card-btn-NodeA');
    const btnB = screen.getByTestId('quick-node-card-btn-NodeB');
    const btnC = screen.getByTestId('quick-node-card-btn-NodeC');

    expect((btnA as HTMLButtonElement).disabled).toBe(true);
    expect((btnB as HTMLButtonElement).disabled).toBe(true);
    expect((btnC as HTMLButtonElement).disabled).toBe(true);

    // The card itself advertises the locked state via the
    // `data-locked` attribute, which downstream styling hooks into.
    const card = screen.getByTestId('quick-node-card');
    expect(card.getAttribute('data-locked')).toBe('true');
  });
});

// ===========================================================================
// Property 3 (UI half) — `switchInProgress.kind === 'node'`, same group
// ===========================================================================

describe('QuickNodeCard — Property 3 (UI half): same-group node lock disables every button', () => {
  it('disables every candidate button when a node switch on the same group is in flight', () => {
    installDesktopBridge();

    render(
      <QuickNodeCard
        primaryGroup={primaryGroup({ name: 'PrimaryGroup' })}
        switchInProgress={{ kind: 'node', group: 'PrimaryGroup' }}
      />,
    );

    const btnA = screen.getByTestId('quick-node-card-btn-NodeA');
    const btnB = screen.getByTestId('quick-node-card-btn-NodeB');
    const btnC = screen.getByTestId('quick-node-card-btn-NodeC');

    expect((btnA as HTMLButtonElement).disabled).toBe(true);
    expect((btnB as HTMLButtonElement).disabled).toBe(true);
    expect((btnC as HTMLButtonElement).disabled).toBe(true);

    const card = screen.getByTestId('quick-node-card');
    expect(card.getAttribute('data-locked')).toBe('true');
  });
});

// ===========================================================================
// Property 3 (UI half) — `switchInProgress.kind === 'node'`, different group
// ===========================================================================

describe('QuickNodeCard — Property 3 (UI half): cross-group node lock leaves card unlocked', () => {
  it('keeps candidate buttons enabled when a node switch on a different group is in flight', () => {
    installDesktopBridge();

    render(
      <QuickNodeCard
        primaryGroup={primaryGroup({ name: 'PrimaryGroup' })}
        switchInProgress={{ kind: 'node', group: 'OtherGroup' }}
      />,
    );

    // Cross-group concurrency is allowed — candidate buttons in
    // PrimaryGroup must stay clickable when OtherGroup is mid-switch.
    const btnA = screen.getByTestId('quick-node-card-btn-NodeA');
    const btnB = screen.getByTestId('quick-node-card-btn-NodeB');
    const btnC = screen.getByTestId('quick-node-card-btn-NodeC');

    expect((btnA as HTMLButtonElement).disabled).toBe(false);
    expect((btnB as HTMLButtonElement).disabled).toBe(false);
    expect((btnC as HTMLButtonElement).disabled).toBe(false);

    const card = screen.getByTestId('quick-node-card');
    expect(card.getAttribute('data-locked')).toBe('false');
  });
});

// ===========================================================================
// Click fires IPC with the expected payload (Requirement 3.5)
// ===========================================================================

describe('QuickNodeCard — click fires switchNode with the correct payload', () => {
  it('invokes window.desktop.switchNode once with { groupName, nodeName }', async () => {
    const { switchNode } = installDesktopBridge();

    render(
      <QuickNodeCard
        primaryGroup={primaryGroup({ name: 'PrimaryGroup' })}
        switchInProgress={false}
      />,
    );

    fireEvent.click(screen.getByTestId('quick-node-card-btn-NodeA'));

    await waitFor(() => {
      expect(switchNode).toHaveBeenCalledTimes(1);
    });
    expect(switchNode).toHaveBeenCalledWith({
      groupName: 'PrimaryGroup',
      nodeName: 'NodeA',
    });
  });
});

// ===========================================================================
// Empty candidates render the placeholder (Requirement 3.4)
// ===========================================================================

describe('QuickNodeCard — empty candidates', () => {
  it('renders the "暂无可推荐节点" placeholder and zero buttons', () => {
    installDesktopBridge();

    render(
      <QuickNodeCard
        primaryGroup={primaryGroup({ candidates: [] })}
        switchInProgress={false}
      />,
    );

    // Placeholder is present with the exact zh-CN copy.
    const empty = screen.getByTestId('quick-node-card-empty');
    expect(empty).toBeDefined();
    expect(empty.textContent ?? '').toMatch(/暂无可推荐节点/);

    // The candidates list and any switch buttons must be absent.
    expect(screen.queryByTestId('quick-node-card-candidates')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// ===========================================================================
// Property 3 (UI half) — sibling buttons disabled during local switch
// ===========================================================================

describe('QuickNodeCard — Property 3 (UI half): sibling disablement during in-flight switch', () => {
  it('disables sibling candidate buttons and labels the firing button "切换中…" while the IPC is pending', async () => {
    // Pin the IPC to a never-resolving promise so the local-switching
    // state holds for the duration of the assertions.
    let resolveSwitch: ((result: SwitchNodeResult) => void) | null = null;
    const pending = new Promise<SwitchNodeResult>((resolve) => {
      resolveSwitch = resolve;
    });
    installDesktopBridge(() => pending);

    render(
      <QuickNodeCard
        primaryGroup={primaryGroup({ name: 'PrimaryGroup' })}
        switchInProgress={false}
      />,
    );

    fireEvent.click(screen.getByTestId('quick-node-card-btn-NodeA'));

    // The firing button flips into the "切换中…" state and its
    // siblings are locked out until the IPC settles.
    await waitFor(() => {
      const btnA = screen.getByTestId('quick-node-card-btn-NodeA');
      expect(btnA.getAttribute('data-firing')).toBe('true');
      expect((btnA as HTMLButtonElement).disabled).toBe(true);
      expect(btnA.textContent ?? '').toMatch(/切换中/);
    });

    const btnB = screen.getByTestId('quick-node-card-btn-NodeB');
    const btnC = screen.getByTestId('quick-node-card-btn-NodeC');

    expect((btnB as HTMLButtonElement).disabled).toBe(true);
    expect((btnC as HTMLButtonElement).disabled).toBe(true);
    expect(btnB.getAttribute('data-firing')).toBe('false');
    expect(btnC.getAttribute('data-firing')).toBe('false');

    // Resolve the pending IPC so the test does not leak a hanging
    // promise into vitest's exit handlers.
    resolveSwitch?.({
      ok: true,
      newCurrent: 'NodeA',
      verifiedAt: Date.now(),
    });
  });
});
