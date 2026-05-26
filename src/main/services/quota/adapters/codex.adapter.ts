import {
  CodexRemoteQuotaError,
  fetchRemoteQuotaForAuth,
} from '../../../collectors/usage/codex-quota.collector';
import {
  expiresAtHasPassed,
  jwtExpiresAtHasPassed,
  okSnapshot,
  ProviderAdapterError,
  unavailableSnapshot,
} from './common';
import type { ProviderAdapter } from './types';

type FetchCodexRemoteQuotaForAuth = typeof fetchRemoteQuotaForAuth;

export interface CodexAdapterDeps {
  readonly fetchRemoteQuotaForAuth?: FetchCodexRemoteQuotaForAuth;
}

export function createCodexAdapter(deps: CodexAdapterDeps = {}): ProviderAdapter {
  const fetcher = deps.fetchRemoteQuotaForAuth ?? fetchRemoteQuotaForAuth;

  return {
    provider: 'codex',
    capability: 'official',
    async refresh({ account, getSecret, now, signal }) {
      const secret = getSecret();
      if (secret === null) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'Codex auth token is missing',
        );
      }

      const accessToken =
        typeof secret.accessToken === 'string' ? secret.accessToken.trim() : '';
      const accountId =
        typeof secret.accountId === 'string'
          ? secret.accountId.trim()
          : (account.accountId ?? '').trim();

      if (accessToken.length === 0 || accountId.length === 0) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'Codex auth token or account id is missing',
        );
      }

      if (
        expiresAtHasPassed(secret.expiresAt, now) ||
        jwtExpiresAtHasPassed(accessToken, now)
      ) {
        throw new ProviderAdapterError('auth_expired', 'Codex auth token expired');
      }

      try {
        const remote = await fetcher({
          accessToken,
          accountId,
          capturedAt: now,
          ...(signal !== undefined ? { signal } : {}),
        });
        return okSnapshot(account, now, remote.windows);
      } catch (err) {
        if (err instanceof CodexRemoteQuotaError) {
          throw new ProviderAdapterError(err.code, err.message);
        }
        if (err instanceof ProviderAdapterError) throw err;
        throw new ProviderAdapterError('network_error', 'Codex quota request failed');
      }
    },
  };
}

export const codexAdapter: ProviderAdapter = createCodexAdapter();
