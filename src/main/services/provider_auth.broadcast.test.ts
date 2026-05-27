// Unit tests for `createProviderAuthBroadcaster` and the
// `buildProviderAuthUpdatedPayload` helper.
//
// The broadcaster is intentionally tiny — its job is to fan a single
// payload out to every live BrowserWindow without throwing on a dead
// webContents. The tests below pin both behaviours plus the payload
// shape so the IPC handlers can rely on a closed contract.

import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderAuthUpdatedPayload,
  createProviderAuthBroadcaster,
} from './provider_auth.broadcast';
import type {
  ProviderAuthMetadata,
  QuotaStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, payload: unknown) => void };
}

function makeFakeWindow(opts?: {
  destroyed?: boolean;
  sendFails?: boolean;
}): FakeWindow & { sentPayloads: unknown[] } {
  const sentPayloads: unknown[] = [];
  return {
    sentPayloads,
    isDestroyed: vi.fn(() => Boolean(opts?.destroyed)),
    webContents: {
      send: vi.fn((_channel: string, payload: unknown) => {
        if (opts?.sendFails) throw new Error('webContents destroyed mid-send');
        sentPayloads.push(payload);
      }),
    },
  };
}

const FAKE_QUOTA_STATUS: QuotaStatus = { snapshots: [] };
const FAKE_ROW: ProviderAuthMetadata = {
  id: 'row-1',
  provider: 'xiaomi',
  label: 'xiaomi:test',
  source: 'manual-api-key',
  accountId: null,
  projectId: null,
  quotaCapability: 'official',
  importedAt: 1,
  updatedAt: 1,
  lastValidatedAt: 1,
  lastQuotaAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  enabled: true,
};

// ---------------------------------------------------------------------------
// buildProviderAuthUpdatedPayload
// ---------------------------------------------------------------------------

describe('buildProviderAuthUpdatedPayload', () => {
  it('round-trips reason + rows + quotaStatus verbatim', () => {
    const payload = buildProviderAuthUpdatedPayload(
      'created',
      [FAKE_ROW],
      FAKE_QUOTA_STATUS,
    );
    expect(payload).toEqual({
      reason: 'created',
      rows: [FAKE_ROW],
      quotaStatus: FAKE_QUOTA_STATUS,
    });
  });

  it('accepts every documented reason discriminator', () => {
    const reasons = [
      'created',
      'deleted',
      'updated',
      'imported',
      'quota-refreshed',
    ] as const;
    for (const reason of reasons) {
      const payload = buildProviderAuthUpdatedPayload(
        reason,
        [],
        FAKE_QUOTA_STATUS,
      );
      expect(payload.reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// createProviderAuthBroadcaster
// ---------------------------------------------------------------------------

describe('createProviderAuthBroadcaster', () => {
  it('sends the payload to every live window on the provider-auth.updated channel', () => {
    const w1 = makeFakeWindow();
    const w2 = makeFakeWindow();
    const broadcaster = createProviderAuthBroadcaster({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getWindows: () => [w1 as any, w2 as any],
    });

    const payload = buildProviderAuthUpdatedPayload(
      'created',
      [FAKE_ROW],
      FAKE_QUOTA_STATUS,
    );
    broadcaster.broadcast(payload);

    expect(w1.webContents.send).toHaveBeenCalledWith(
      'provider-auth.updated',
      payload,
    );
    expect(w2.webContents.send).toHaveBeenCalledWith(
      'provider-auth.updated',
      payload,
    );
  });

  it('skips destroyed windows without throwing', () => {
    const dead = makeFakeWindow({ destroyed: true });
    const live = makeFakeWindow();
    const broadcaster = createProviderAuthBroadcaster({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getWindows: () => [dead as any, live as any],
    });

    expect(() =>
      broadcaster.broadcast(
        buildProviderAuthUpdatedPayload('deleted', [], FAKE_QUOTA_STATUS),
      ),
    ).not.toThrow();

    expect(dead.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalled();
  });

  it('continues iterating when one webContents throws on send', () => {
    const flaky = makeFakeWindow({ sendFails: true });
    const live = makeFakeWindow();
    const broadcaster = createProviderAuthBroadcaster({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getWindows: () => [flaky as any, live as any],
    });

    expect(() =>
      broadcaster.broadcast(
        buildProviderAuthUpdatedPayload('updated', [], FAKE_QUOTA_STATUS),
      ),
    ).not.toThrow();

    expect(flaky.webContents.send).toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalled();
    expect(live.sentPayloads).toHaveLength(1);
  });

  it('reflects window list mutation between calls (lazy resolution)', () => {
    let live = true;
    const w1 = makeFakeWindow();
    const broadcaster = createProviderAuthBroadcaster({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getWindows: () => (live ? [w1 as any] : []),
    });

    broadcaster.broadcast(
      buildProviderAuthUpdatedPayload('created', [], FAKE_QUOTA_STATUS),
    );
    expect(w1.webContents.send).toHaveBeenCalledTimes(1);

    live = false;
    broadcaster.broadcast(
      buildProviderAuthUpdatedPayload('deleted', [], FAKE_QUOTA_STATUS),
    );
    expect(w1.webContents.send).toHaveBeenCalledTimes(1);
  });
});
