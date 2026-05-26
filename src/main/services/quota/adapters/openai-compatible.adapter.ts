// OpenAI-compatible provider adapter — Foundation Phase placeholder (health_only).
//
// Generic OpenAI-compatible endpoints (custom self-hosted, third-party
// gateways) expose no first-party quota; the v1.1 adapter will perform
// a lightweight reachability + auth check against the configured
// `baseUrl` and emit a `kind: 'health'` snapshot. v1 returns the
// `unsupported` placeholder so the dispatcher path is exercised
// end-to-end without any outbound traffic.

import type { ProviderAdapter } from './types';

export const openaiCompatibleAdapter: ProviderAdapter = {
  provider: 'openai-compatible',
  capability: 'health_only',
  async refresh({ account, now }) {
    return {
      provider: 'openai-compatible',
      capturedAt: now,
      source: 'health_check',
      windows: [],
      providerAuthId: account.id,
      accountLabel: account.label,
      accountId: account.accountId,
      projectId: account.projectId,
      kind: 'health',
      status: 'unsupported',
      rawPlanLabel: null,
      modelGroup: null,
      lastErrorCode: 'unsupported',
      lastErrorMessage: 'adapter not implemented in v1',
    };
  },
};
