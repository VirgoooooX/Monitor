// Unit tests for the Kiro IDE refresh-token exchange.
//
// These cover the social-login refresh flow (Kiro Desktop Auth)
// since that is the only one v1 auto-refreshes. SSO / IAM Identity
// Center is documented as `unsupported` and exercised below.

import { describe, it, expect, vi } from 'vitest';

import { ProviderAdapterError } from './common';
import {
  buildSocialRefreshUrl,
  parseSocialRefreshResponse,
  refreshKiroToken,
  KIRO_REFRESH_INTERNALS,
} from './kiro-token-refresher';

describe('buildSocialRefreshUrl', () => {
  it('builds the regional Kiro Desktop Auth URL', () => {
    expect(buildSocialRefreshUrl('us-east-1')).toBe(
      'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken',
    );
    expect(buildSocialRefreshUrl('eu-central-1')).toBe(
      'https://prod.eu-central-1.auth.desktop.kiro.dev/refreshToken',
    );
  });
});

describe('parseSocialRefreshResponse', () => {
  const NOW = 1_780_000_000_000;

  it('extracts every field from the canonical response shape', () => {
    const result = parseSocialRefreshResponse(
      {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 3600,
        profileArn: 'arn:aws:codewhisperer:us-east-1:111:profile/AAA',
      },
      'old-refresh',
      NOW,
    );

    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.profileArn).toBe(
      'arn:aws:codewhisperer:us-east-1:111:profile/AAA',
    );
    // 1 hour - 60s skew = 3540 seconds ahead
    expect(result.expiresAt).toBe(NOW + 3540 * 1000);
  });

  it('falls back to the input refresh token when the server omits it', () => {
    const result = parseSocialRefreshResponse(
      { accessToken: 'new-access', expiresIn: 3600 },
      'old-refresh',
      NOW,
    );
    expect(result.refreshToken).toBe('old-refresh');
  });

  it('falls back to a 1-hour TTL when expiresIn is missing', () => {
    const result = parseSocialRefreshResponse(
      { accessToken: 'new-access' },
      'old-refresh',
      NOW,
    );
    expect(result.expiresAt).toBe(
      NOW +
        KIRO_REFRESH_INTERNALS.DEFAULT_EXPIRES_IN_SECONDS * 1000 -
        KIRO_REFRESH_INTERNALS.EXPIRY_SKEW_MS,
    );
  });

  it('throws network_error on a non-object response', () => {
    expect(() =>
      parseSocialRefreshResponse('not-an-object', 'rt', NOW),
    ).toThrowError(ProviderAdapterError);
    expect(() =>
      parseSocialRefreshResponse('not-an-object', 'rt', NOW),
    ).toThrowError(/refresh response was not an object/);
  });

  it('throws network_error when accessToken is missing', () => {
    expect(() =>
      parseSocialRefreshResponse({ refreshToken: 'rt' }, 'rt', NOW),
    ).toThrowError(/missing accessToken/);
  });

  it('returns null profileArn when the server omits it', () => {
    const result = parseSocialRefreshResponse(
      { accessToken: 'new-access', expiresIn: 3600 },
      'old-refresh',
      NOW,
    );
    expect(result.profileArn).toBeNull();
  });
});

describe('refreshKiroToken', () => {
  const NOW = 1_780_000_000_000;

  it('issues a POST to the Kiro Desktop Auth endpoint with the refresh token in the JSON body', async () => {
    const requestJson = vi.fn(async () => ({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
    }));

    const result = await refreshKiroToken(
      {
        refreshToken: 'old-refresh',
        authMethod: 'social',
        region: 'us-east-1',
      },
      { requestJson, now: () => NOW },
    );

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0]![0]).toMatchObject({
      url: 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken',
      method: 'POST',
      body: { refreshToken: 'old-refresh' },
    });
    expect(result.accessToken).toBe('new-access');
  });

  it('defaults to social when authMethod is null', async () => {
    const requestJson = vi.fn(async () => ({
      accessToken: 'a',
      refreshToken: 'b',
      expiresIn: 3600,
    }));

    await refreshKiroToken(
      { refreshToken: 'rt', authMethod: null, region: 'us-east-1' },
      { requestJson, now: () => NOW },
    );

    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('throws auth_expired for the SSO / IAM Identity Center path (not yet supported)', async () => {
    await expect(
      refreshKiroToken(
        { refreshToken: 'rt', authMethod: 'sso', region: 'us-east-1' },
        { requestJson: vi.fn() as never, now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('throws auth_expired when the refresh token is empty', async () => {
    const requestJson = vi.fn();
    await expect(
      refreshKiroToken(
        { refreshToken: '   ', authMethod: 'social', region: 'us-east-1' },
        { requestJson: requestJson as never, now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: 'auth_expired' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('maps an upstream 4xx (upstream_changed) to auth_expired', async () => {
    const requestJson = vi.fn(async () => {
      throw new ProviderAdapterError('upstream_changed', 'upstream returned HTTP 400');
    });

    await expect(
      refreshKiroToken(
        { refreshToken: 'rt', authMethod: 'social', region: 'us-east-1' },
        { requestJson: requestJson as never, now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('maps an upstream 401 (upstream_unauthorized) to auth_expired', async () => {
    const requestJson = vi.fn(async () => {
      throw new ProviderAdapterError(
        'upstream_unauthorized',
        'upstream returned HTTP 401',
      );
    });

    await expect(
      refreshKiroToken(
        { refreshToken: 'rt', authMethod: 'social', region: 'us-east-1' },
        { requestJson: requestJson as never, now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('preserves transient network_error codes verbatim', async () => {
    const requestJson = vi.fn(async () => {
      throw new ProviderAdapterError('network_error', 'request timeout');
    });

    await expect(
      refreshKiroToken(
        { refreshToken: 'rt', authMethod: 'social', region: 'us-east-1' },
        { requestJson: requestJson as never, now: () => NOW },
      ),
    ).rejects.toMatchObject({ code: 'network_error' });
  });
});
