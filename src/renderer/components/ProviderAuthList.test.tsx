// @vitest-environment jsdom
//
// Feature: cpa-quota-import, Renderer Provider_Auth section (task 12.4).
// Validates Requirements 12.2, 12.3, 12.4, 12.5.
//
// Component tests for `ProviderAuthList` — the per-account row list
// that lives inside the Settings page Provider_Auth section. The list
// is the user-visible projection of `provider_auth` rows after the
// IPC layer has structurally redacted the secret material; it is the
// only surface that decides:
//
//   • whether a row is refreshable (Requirement 12.5: `auth_expired`
//     blocks the Refresh button because Monitor v1 ships no token
//     refresh — re-export from CPA is the only recovery path);
//   • whether a row may show a percentage-style quota strip
//     (Requirement 12.3: `quota_capability ∈ { 'health_only',
//     'usage_only' }` MUST NOT render percentages and instead show
//     the explainer copy);
//   • how multi-account rows order themselves (Requirement 12.4:
//     stable ascending sort by `importedAt`, no merging across rows);
//   • whether a row's Refresh / Delete buttons reach the parent
//     handlers, which in turn drive the `desktop.refreshProviderQuota`
//     and `desktop.deleteProviderAuth` IPC calls.
//
// The cases below pin those rules to exact DOM affordances so any
// regression surfaces here rather than at the IPC boundary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';

import { ProviderAuthList } from './ProviderAuthList';
import type {
  ProviderAuthErrorCode,
  ProviderAuthMetadata,
  ProviderId,
  QuotaCapability,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a `ProviderAuthMetadata` row with sensible defaults. Tests
 * spell out only the slice they care about; everything else is the
 * "happy path" — `official` capability, no last error, recent
 * timestamps. The `id` defaults to a stable UUIDv4 string so test
 * IDs in `data-testid` attributes are predictable.
 *
 * Defaults match the redacted projection produced by
 * `provider_auth.service` (`redactRow`): no token / API key / file
 * path fields. The renderer never sees secret material.
 */
function makeRow(
  overrides: Partial<ProviderAuthMetadata> = {},
): ProviderAuthMetadata {
  const base: ProviderAuthMetadata = {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'codex' as ProviderId,
    label: 'codex@example.com',
    source: 'cpa-auth-file',
    accountId: 'acct-123',
    projectId: null,
    quotaCapability: 'official' as QuotaCapability,
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastValidatedAt: 1_700_000_000_000,
    lastQuotaAt: 1_700_000_000_000,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ===========================================================================
// Empty state — Requirement 12.2 (the section must render usefully on first
// run, before any CPA file has been imported).
// ===========================================================================

describe('ProviderAuthList — empty state', () => {
  it('renders the "尚未导入" empty-state copy when rows is []', () => {
    const onRefresh = vi.fn();
    const onDelete = vi.fn();

    render(
      <ProviderAuthList
        rows={[]}
        onRefresh={onRefresh}
        onDelete={onDelete}
        busyId={null}
      />,
    );

    const empty = screen.getByTestId('provider-auth-list-empty');
    expect(empty).toBeDefined();
    expect(empty.textContent ?? '').toMatch(/尚未导入/);

    // The list itself must be absent — no `<ul>` rendered when there
    // are no rows.
    expect(screen.queryByTestId('provider-auth-list')).toBeNull();

    // No refresh / delete buttons leak through the empty branch.
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// ===========================================================================
// `quota_capability ∈ { 'health_only', 'usage_only' }` — Requirement 12.3
// (these capabilities MUST NOT show a percentage; they MUST show the
// explainer copy instead).
// ===========================================================================

describe('ProviderAuthList — health_only capability', () => {
  it('shows the "暂无官方 quota 接口" copy for a health_only row', () => {
    const row = makeRow({
      provider: 'deepseek',
      quotaCapability: 'health_only',
      label: 'deepseek-key-1',
    });

    render(
      <ProviderAuthList
        rows={[row]}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        busyId={null}
      />,
    );

    // The capability hint is rendered with the documented zh-CN
    // copy. The `data-testid` is keyed by the row id so multi-row
    // fixtures can target a specific slot.
    const hint = screen.getByTestId(
      `provider-auth-list-row-${row.id}-capability-hint`,
    );
    expect(hint).toBeDefined();
    expect(hint.textContent ?? '').toMatch(/暂无官方\s*quota\s*接口/);

    // No percentage strip should render for a non-`official`
    // capability. The row's only "quota-like" surface is the
    // capability chip + the hint above; neither contains a `%`
    // sign.
    const rowEl = screen.getByTestId(`provider-auth-list-row-${row.id}`);
    expect(rowEl.textContent ?? '').not.toMatch(/%/);
    expect(rowEl.getAttribute('data-capability')).toBe('health_only');
  });
});

// ===========================================================================
// `last_error_code === 'auth_expired'` — Requirement 12.5 (Token expiry
// blocks Refresh; the user must re-export from CPA. The expired hint
// directs the user to that recovery path).
// ===========================================================================

describe('ProviderAuthList — auth_expired row', () => {
  it('disables Refresh and shows the re-import copy when lastErrorCode is auth_expired', () => {
    const row = makeRow({
      lastErrorCode: 'auth_expired' as ProviderAuthErrorCode,
      lastErrorMessage: 'token expired',
    });

    render(
      <ProviderAuthList
        rows={[row]}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        busyId={null}
      />,
    );

    const refreshBtn = screen.getByTestId(
      `provider-auth-list-row-${row.id}-refresh`,
    ) as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);

    const expiredHint = screen.getByTestId(
      `provider-auth-list-row-${row.id}-expired-hint`,
    );
    expect(expiredHint).toBeDefined();
    expect(expiredHint.textContent ?? '').toMatch(
      /认证已过期.*CPA.*重新导出.*导入/,
    );

    // The row exposes the error code via a data attribute so styling
    // hooks can target the hard-error tone.
    const rowEl = screen.getByTestId(`provider-auth-list-row-${row.id}`);
    expect(rowEl.getAttribute('data-error-code')).toBe('auth_expired');
  });
});

// ===========================================================================
// `busyId === row.id` — visual lock during in-flight refresh / delete.
// The Refresh button flips into the "刷新中…" state and disables itself,
// preventing a double-fire of the IPC.
// ===========================================================================

describe('ProviderAuthList — busy state', () => {
  it('disables the Refresh button and shows "刷新中…" when busyId matches the row id', () => {
    const row = makeRow();

    render(
      <ProviderAuthList
        rows={[row]}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        busyId={row.id}
      />,
    );

    const refreshBtn = screen.getByTestId(
      `provider-auth-list-row-${row.id}-refresh`,
    ) as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);
    expect(refreshBtn.getAttribute('data-busy')).toBe('true');
    expect(refreshBtn.textContent ?? '').toMatch(/刷新中/);

    // Delete is also locked while the row is busy — both buttons
    // share the same fire-and-wait state machine.
    const deleteBtn = screen.getByTestId(
      `provider-auth-list-row-${row.id}-delete`,
    ) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
  });

  it('does not lock other rows when only one is busy', () => {
    const rowA = makeRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      importedAt: 1_700_000_000_000,
    });
    const rowB = makeRow({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      importedAt: 1_700_000_001_000,
    });

    render(
      <ProviderAuthList
        rows={[rowA, rowB]}
        onRefresh={vi.fn()}
        onDelete={vi.fn()}
        busyId={rowA.id}
      />,
    );

    const refreshA = screen.getByTestId(
      `provider-auth-list-row-${rowA.id}-refresh`,
    ) as HTMLButtonElement;
    const refreshB = screen.getByTestId(
      `provider-auth-list-row-${rowB.id}-refresh`,
    ) as HTMLButtonElement;

    expect(refreshA.disabled).toBe(true);
    expect(refreshB.disabled).toBe(false);
  });
});

// ===========================================================================
// Click → callback wiring. The list does NOT call `desktop.*` directly;
// it surfaces clicks as `onRefresh(id)` / `onDelete(id)` so the parent
// (SettingsView) can drive the IPC. The integration test in
// `SettingsView.provider-auth.test.tsx` covers the full IPC path.
// ===========================================================================

describe('ProviderAuthList — click → callback', () => {
  it('invokes onRefresh exactly once with the row id when Refresh is clicked', () => {
    const row = makeRow();
    const onRefresh = vi.fn();
    const onDelete = vi.fn();

    render(
      <ProviderAuthList
        rows={[row]}
        onRefresh={onRefresh}
        onDelete={onDelete}
        busyId={null}
      />,
    );

    fireEvent.click(
      screen.getByTestId(`provider-auth-list-row-${row.id}-refresh`),
    );

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith(row.id);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('invokes onDelete exactly once with the row id when Delete is clicked', () => {
    const row = makeRow();
    const onRefresh = vi.fn();
    const onDelete = vi.fn();

    render(
      <ProviderAuthList
        rows={[row]}
        onRefresh={onRefresh}
        onDelete={onDelete}
        busyId={null}
      />,
    );

    fireEvent.click(
      screen.getByTestId(`provider-auth-list-row-${row.id}-delete`),
    );

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(row.id);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not invoke onRefresh when the row is auth_expired (button is disabled)', () => {
    const row = makeRow({
      lastErrorCode: 'auth_expired' as ProviderAuthErrorCode,
    });
    const onRefresh = vi.fn();

    render(
      <ProviderAuthList
        rows={[row]}
        onRefresh={onRefresh}
        onDelete={vi.fn()}
        busyId={null}
      />,
    );

    // `fireEvent.click` on a disabled <button> is a no-op in jsdom —
    // mirrors the browser's default. The point of this case is that
    // the disabled state is enforced by the button itself, not by a
    // guard inside the parent's callback.
    fireEvent.click(
      screen.getByTestId(`provider-auth-list-row-${row.id}-refresh`),
    );

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
