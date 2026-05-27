// Kiro IDE adapter — unit tests against a stubbed HTTP layer.
//
// The fixtures mirror the live response captured against a Pro+
// account on 2026-05-27 (see docs/postmortems if we ever need to
// refresh them). We pin the JSON shape because the AWS Smithy
// codegen on the IDE side is closed-source — if the response shape
// changes upstream we want the test to break loudly.

import { describe, it, expect, vi } from 'vitest';

import {
  buildUsageLimitsUrl,
  breakdownToWindow,
  createKiroIdeAdapter,
  parseFirstBreakdown,
  readPlanLabel,
  resolveRegion,
} from './kiro-ide.adapter';
import type { ProviderAuthRow } from '../../../store/repositories';
import type { ProviderAuthSecretPayload } from '../../../types';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('resolveRegion', () => {
  it('extracts the region from a valid ARN', () => {
    expect(
      resolveRegion('arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABCD1234'),
    ).toBe('eu-central-1');
  });

  it('falls back to us-east-1 for malformed ARNs', () => {
    expect(resolveRegion('')).toBe('us-east-1');
    expect(resolveRegion('not-an-arn')).toBe('us-east-1');
    expect(resolveRegion('arn:aws:s3:us-east-1:123:bucket/x')).toBe('us-east-1');
  });

  it('rejects unsupported regions to stop a tampered ARN from driving requests off-target', () => {
    expect(
      resolveRegion('arn:aws:codewhisperer:zz-fake-99:123456789012:profile/ABCD1234'),
    ).toBe('us-east-1');
  });
});

describe('buildUsageLimitsUrl', () => {
  it('builds the canonical URL with parameters in the IDE-equivalent order', () => {
    const url = buildUsageLimitsUrl(
      'us-east-1',
      'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCD1234',
    );
    expect(url).toBe(
      'https://q.us-east-1.amazonaws.com/getUsageLimits' +
        '?isEmailRequired=true&origin=AI_EDITOR' +
        '&profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A123456789012%3Aprofile%2FABCD1234' +
        '&resourceType=AGENTIC_REQUEST',
    );
  });

  it('omits profileArn when blank', () => {
    expect(buildUsageLimitsUrl('us-east-1', '')).toBe(
      'https://q.us-east-1.amazonaws.com/getUsageLimits' +
        '?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST',
    );
  });
});

describe('parseFirstBreakdown', () => {
  it('returns the first usageBreakdownList row', () => {
    const result = parseFirstBreakdown({
      usageBreakdownList: [{ a: 1 }, { a: 2 }],
    });
    expect(result).toEqual({ a: 1 });
  });

  it('returns null for missing or empty lists', () => {
    expect(parseFirstBreakdown(null)).toBeNull();
    expect(parseFirstBreakdown({})).toBeNull();
    expect(parseFirstBreakdown({ usageBreakdownList: [] })).toBeNull();
  });
});

describe('breakdownToWindow', () => {
  const now = Date.UTC(2026, 4, 27, 10, 0, 0);

  it('builds a window from the live response shape', () => {
    const window = breakdownToWindow(
      {
        currentUsage: 37,
        currentUsageWithPrecision: 37.43,
        usageLimit: 2000,
        usageLimitWithPrecision: 2000.0,
        // 1.780272E9 epoch seconds → 2026-06-01T08:00:00Z
        nextDateReset: 1.780272e9,
      },
      now,
    );

    expect(window).not.toBeNull();
    // (2000 - 37.43) / 2000 * 100 = 98.1285 → rounds to 98.13.
    expect(window!.percentLeft).toBeCloseTo(98.13, 2);
    expect(window!.resetAt).toBe(1_780_272_000_000);
    expect(window!.windowSeconds).toBeNull();
    expect(window!.name).toBe('kiro-credits');
  });

  it('clamps depleted credits to 0%', () => {
    const window = breakdownToWindow(
      {
        currentUsageWithPrecision: 2200,
        usageLimitWithPrecision: 2000,
        nextDateReset: 1.780272e9,
      },
      now,
    );
    expect(window!.percentLeft).toBe(0);
  });

  it('returns null when limit is missing', () => {
    expect(breakdownToWindow({ currentUsage: 5 }, now)).toBeNull();
  });
});

describe('readPlanLabel', () => {
  it('extracts the subscription title', () => {
    expect(
      readPlanLabel({ subscriptionInfo: { subscriptionTitle: 'KIRO PRO+' } }),
    ).toBe('KIRO PRO+');
  });

  it('returns null when missing', () => {
    expect(readPlanLabel({})).toBeNull();
    expect(readPlanLabel({ subscriptionInfo: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end adapter behaviour with a stubbed transport
// ---------------------------------------------------------------------------

const SAMPLE_RESPONSE = {
  daysUntilReset: 0,
  limits: [],
  nextDateReset: 1.780272e9,
  overageConfiguration: { overageStatus: 'ENABLED' },
  subscriptionInfo: {
    overageCapability: 'OVERAGE_CAPABLE',
    subscriptionTitle: 'KIRO PRO+',
    type: 'Q_DEVELOPER_STANDALONE_PRO_PLUS',
  },
  usageBreakdownList: [
    {
      currency: 'USD',
      currentUsage: 37,
      currentUsageWithPrecision: 37.43,
      displayName: 'Credit',
      nextDateReset: 1.780272e9,
      overageCap: 10000,
      overageCapWithPrecision: 10000.0,
      resourceType: 'CREDIT',
      unit: 'INVOCATIONS',
      usageLimit: 2000,
      usageLimitWithPrecision: 2000.0,
    },
  ],
  userInfo: { email: 'test@example.com', userId: 'user-1' },
};

function makeAccount(): ProviderAuthRow {
  return {
    id: 'acct-1',
    provider: 'kiro-ide',
    label: 'Kiro IDE',
    source: 'cpa-auth-file',
    accountId: 'user-1',
    projectId: null,
    quotaCapability: 'official',
    importedAt: 1,
    updatedAt: 1,
    lastValidatedAt: null,
    lastQuotaAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    enabled: true,
    secretKey: 'cpaAuth.providerAuth.acct-1',
  };
}

function makeSecret(
  overrides: Partial<ProviderAuthSecretPayload> = {},
): ProviderAuthSecretPayload {
  return {
    accessToken: 'kiro-access-token',
    refreshToken: 'kiro-refresh-token',
    kiroProfileArn:
      'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABCD1234',
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

describe('createKiroIdeAdapter — refresh', () => {
  it('produces an ok snapshot from the live response shape', async () => {
    const requestJson = vi.fn(async () => SAMPLE_RESPONSE);
    const adapter = createKiroIdeAdapter({ requestJson });
    const snapshot = await adapter.refresh({
      account: makeAccount(),
      getSecret: () => makeSecret(),
      now: 1_779_500_000_000,
    });

    expect(snapshot.status).toBe('ok');
    expect(snapshot.kind).toBe('quota');
    expect(snapshot.rawPlanLabel).toBe('KIRO PRO+');
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]!.name).toBe('kiro-credits');
    expect(snapshot.windows[0]!.percentLeft).toBeCloseTo(98.13, 2);

    // Verify the URL targets the region encoded in the ARN.
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0]![0].url).toMatch(
      /^https:\/\/q\.us-east-1\.amazonaws\.com\/getUsageLimits\?/,
    );
    expect(requestJson.mock.calls[0]![0].headers).toMatchObject({
      Authorization: 'Bearer kiro-access-token',
    });
  });

  it('marks unavailable when the secret is missing', async () => {
    const adapter = createKiroIdeAdapter({
      requestJson: vi.fn(async () => SAMPLE_RESPONSE),
    });
    const snapshot = await adapter.refresh({
      account: makeAccount(),
      getSecret: () => null,
      now: 1_779_500_000_000,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('auth_missing');
  });

  it('throws auth_expired when expiresAt is past and refresh is disabled', async () => {
    const requestJson = vi.fn(async () => SAMPLE_RESPONSE);
    const adapter = createKiroIdeAdapter({
      requestJson,
      getRefreshSettings: () => ({ enabled: false, writeBackAuthFile: false }),
    });

    await expect(
      adapter.refresh({
        account: makeAccount(),
        getSecret: () => makeSecret({ expiresAt: 1_779_400_000_000 }),
        now: 1_779_500_000_000,
      }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('throws auth_expired when expiresAt is past and no refresh token is available', async () => {
    const requestJson = vi.fn(async () => SAMPLE_RESPONSE);
    const adapter = createKiroIdeAdapter({ requestJson });

    await expect(
      adapter.refresh({
        account: makeAccount(),
        getSecret: () =>
          makeSecret({
            expiresAt: 1_779_400_000_000,
            refreshToken: '',
          }),
        now: 1_779_500_000_000,
      }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('marks upstream_changed when usageBreakdownList is missing', async () => {
    const adapter = createKiroIdeAdapter({
      requestJson: vi.fn(async () => ({
        ...SAMPLE_RESPONSE,
        usageBreakdownList: [],
      })),
    });
    const snapshot = await adapter.refresh({
      account: makeAccount(),
      getSecret: () => makeSecret(),
      now: 1_779_500_000_000,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.lastErrorCode).toBe('upstream_changed');
  });
});

// ---------------------------------------------------------------------------
// Auto-refresh path (B 方案: refresh + write-back to source file)
// ---------------------------------------------------------------------------

const REFRESH_URL_RE =
  /^https:\/\/prod\.us-east-1\.auth\.desktop\.kiro\.dev\/refreshToken$/;

const FRESH_REFRESH_RESPONSE = {
  accessToken: 'kiro-rotated-access-token',
  refreshToken: 'kiro-rotated-refresh-token',
  expiresIn: 3600,
} as const;

describe('createKiroIdeAdapter — auto refresh', () => {
  it('refreshes the access token when expiresAt is within the threshold', async () => {
    const refreshCalls: unknown[] = [];
    const requestJson = vi.fn(async (input: { url: string }) => {
      if (REFRESH_URL_RE.test(input.url)) {
        refreshCalls.push(input);
        return FRESH_REFRESH_RESPONSE;
      }
      return SAMPLE_RESPONSE;
    });
    const persisted: unknown[] = [];
    const adapter = createKiroIdeAdapter({
      requestJson: requestJson as never,
      // Disable file write-back so the test does not touch the
      // filesystem; the secret persistence is what matters.
      getRefreshSettings: () => ({ enabled: true, writeBackAuthFile: false }),
    });

    const NOW = 1_779_500_000_000;
    const snapshot = await adapter.refresh({
      account: makeAccount(),
      // expiresAt 60s away — inside the 5-minute threshold.
      getSecret: () => makeSecret({ expiresAt: NOW + 60_000 }),
      now: NOW,
      persistSecret: (payload) => persisted.push(payload),
    });

    expect(snapshot.status).toBe('ok');
    expect(refreshCalls).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      accessToken: 'kiro-rotated-access-token',
      refreshToken: 'kiro-rotated-refresh-token',
    });
    // Quota call should use the rotated token.
    const quotaCall = requestJson.mock.calls.find(
      ([input]) => !REFRESH_URL_RE.test((input as { url: string }).url),
    );
    expect(quotaCall).toBeDefined();
    expect((quotaCall![0] as { headers: Record<string, string> }).headers).toMatchObject({
      Authorization: 'Bearer kiro-rotated-access-token',
    });
  });

  it('does not refresh when expiresAt is comfortably in the future', async () => {
    const requestJson = vi.fn(async () => SAMPLE_RESPONSE);
    const adapter = createKiroIdeAdapter({ requestJson });

    const NOW = 1_779_500_000_000;
    const snapshot = await adapter.refresh({
      account: makeAccount(),
      // Expires in 1 hour — outside the threshold.
      getSecret: () => makeSecret({ expiresAt: NOW + 60 * 60_000 }),
      now: NOW,
      persistSecret: vi.fn(),
    });

    expect(snapshot.status).toBe('ok');
    // Only the quota call — no refresh.
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect((requestJson.mock.calls[0]![0] as { url: string }).url).not.toMatch(
      REFRESH_URL_RE,
    );
  });

  it('does not refresh when settings.kiroTokenRefresh.enabled is false', async () => {
    const requestJson = vi.fn(async () => SAMPLE_RESPONSE);
    const adapter = createKiroIdeAdapter({
      requestJson,
      getRefreshSettings: () => ({ enabled: false, writeBackAuthFile: false }),
    });

    const NOW = 1_779_500_000_000;
    const snapshot = await adapter.refresh({
      account: makeAccount(),
      // Expires in 1 second — would normally trigger refresh.
      getSecret: () => makeSecret({ expiresAt: NOW + 1_000 }),
      now: NOW,
      persistSecret: vi.fn(),
    });

    // With refresh disabled but token still valid (1s ahead), the
    // adapter falls through to the quota call which succeeds.
    expect(snapshot.status).toBe('ok');
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect((requestJson.mock.calls[0]![0] as { url: string }).url).not.toMatch(
      REFRESH_URL_RE,
    );
  });

  it('treats a 400 invalid_grant on refresh as auth_expired', async () => {
    const { ProviderAdapterError } = await import('./common');
    const requestJson = vi.fn(async (input: { url: string }) => {
      if (REFRESH_URL_RE.test(input.url)) {
        throw new ProviderAdapterError(
          'upstream_changed',
          'upstream returned HTTP 400',
        );
      }
      return SAMPLE_RESPONSE;
    });
    const adapter = createKiroIdeAdapter({ requestJson: requestJson as never });

    const NOW = 1_779_500_000_000;
    await expect(
      adapter.refresh({
        account: makeAccount(),
        getSecret: () => makeSecret({ expiresAt: NOW + 60_000 }),
        now: NOW,
        persistSecret: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('continues with the existing access token when refresh hits a transient network error', async () => {
    const { ProviderAdapterError } = await import('./common');
    const requestJson = vi.fn(async (input: { url: string }) => {
      if (REFRESH_URL_RE.test(input.url)) {
        throw new ProviderAdapterError('network_error', 'request timeout');
      }
      return SAMPLE_RESPONSE;
    });
    const adapter = createKiroIdeAdapter({ requestJson: requestJson as never });

    const NOW = 1_779_500_000_000;
    const snapshot = await adapter.refresh({
      account: makeAccount(),
      // Within threshold (refresh attempted) but token still ~3 min ahead.
      getSecret: () => makeSecret({ expiresAt: NOW + 3 * 60_000 }),
      now: NOW,
      persistSecret: vi.fn(),
    });

    // Refresh failed but the existing access token is still valid →
    // adapter soldiers on with it.
    expect(snapshot.status).toBe('ok');
  });

  it('coalesces concurrent refresh calls into a single refresh-token exchange', async () => {
    let pendingResolve: ((value: typeof FRESH_REFRESH_RESPONSE) => void) | null = null;
    const refreshCalls: unknown[] = [];
    const requestJson = vi.fn(async (input: { url: string }) => {
      if (REFRESH_URL_RE.test(input.url)) {
        refreshCalls.push(input);
        return new Promise<typeof FRESH_REFRESH_RESPONSE>((resolve) => {
          pendingResolve = resolve;
        });
      }
      return SAMPLE_RESPONSE;
    });
    const adapter = createKiroIdeAdapter({
      requestJson: requestJson as never,
      getRefreshSettings: () => ({ enabled: true, writeBackAuthFile: false }),
    });

    const NOW = 1_779_500_000_000;
    const account = makeAccount();
    const secret = makeSecret({ expiresAt: NOW + 60_000 });

    const callA = adapter.refresh({
      account,
      getSecret: () => secret,
      now: NOW,
      persistSecret: vi.fn(),
    });
    const callB = adapter.refresh({
      account,
      getSecret: () => secret,
      now: NOW,
      persistSecret: vi.fn(),
    });

    // Both calls suspended waiting on the refresh; only one
    // refresh request has been issued.
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshCalls).toHaveLength(1);

    pendingResolve!(FRESH_REFRESH_RESPONSE);
    const [a, b] = await Promise.all([callA, callB]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(refreshCalls).toHaveLength(1);
  });
});
