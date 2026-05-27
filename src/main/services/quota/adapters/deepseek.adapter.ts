// DeepSeek provider adapter — official account balance endpoint.

import {
  asRecord,
  okSnapshot,
  ProviderAdapterError,
  requestJson,
  type RequestJson,
  unavailableSnapshot,
} from './common';
import type { ProviderAdapter } from './types';

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

export interface DeepSeekAdapterDeps {
  readonly requestJson?: RequestJson;
}

export function createDeepSeekAdapter(
  deps: DeepSeekAdapterDeps = {},
): ProviderAdapter {
  const doRequest = deps.requestJson ?? requestJson;

  return {
    provider: 'deepseek',
    capability: 'official',
    async refresh({ account, getSecret, now, signal }) {
      const secret = getSecret();
      if (secret === null) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'DeepSeek API key is missing',
          'credits',
        );
      }

      const apiKey =
        typeof secret.apiKey === 'string' ? secret.apiKey.trim() : '';
      if (apiKey.length === 0) {
        return unavailableSnapshot(
          account,
          now,
          'auth_missing',
          'DeepSeek API key is missing',
          'credits',
        );
      }

      const response = await doRequest<unknown>({
        url: DEEPSEEK_BALANCE_URL,
        method: 'GET',
        ...(signal !== undefined ? { signal } : {}),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      });

      const parsed = parseDeepSeekBalance(response);
      return okSnapshot(account, now, parsed.windows, {
        kind: 'credits',
        rawPlanLabel: parsed.rawPlanLabel,
      });
    },
  };
}

function parseDeepSeekBalance(response: unknown): {
  readonly windows: Array<{
    readonly name: string;
    readonly percentLeft: number | null;
    readonly resetAt: null;
    readonly windowSeconds: null;
  }>;
  readonly rawPlanLabel: string | null;
} {
  const root = asRecord(response);
  const infos = Array.isArray(root?.['balance_infos'])
    ? root['balance_infos']
    : null;
  if (root === null || infos === null) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'DeepSeek balance response missing balance_infos',
    );
  }

  const windows = infos.flatMap((entry) => {
    const record = asRecord(entry);
    if (record === null) return [];
    const currency = stringValue(record['currency']) ?? 'UNKNOWN';
    const total = stringValue(record['total_balance']);
    const granted = stringValue(record['granted_balance']);
    const toppedUp = stringValue(record['topped_up_balance']);
    if (total === null && granted === null && toppedUp === null) return [];

    const parts = [
      total === null ? null : `总额 ${total}`,
      granted === null ? null : `赠金 ${granted}`,
      toppedUp === null ? null : `充值 ${toppedUp}`,
    ].filter((part): part is string => part !== null);

    return [{
      name: `credits:${currency} ${parts.join(' / ')}`,
      percentLeft: availablePercent(root['is_available']),
      resetAt: null,
      windowSeconds: null,
    }];
  });

  if (windows.length === 0) {
    throw new ProviderAdapterError(
      'upstream_changed',
      'DeepSeek balance response missing balances',
    );
  }

  return {
    windows,
    rawPlanLabel: windows.map((window) =>
      window.name.slice('credits:'.length),
    ).join(' · '),
  };
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function availablePercent(value: unknown): number | null {
  return typeof value === 'boolean' ? (value ? 100 : 0) : null;
}

export const deepseekAdapter: ProviderAdapter = createDeepSeekAdapter();
