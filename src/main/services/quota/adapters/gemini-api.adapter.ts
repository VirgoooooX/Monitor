// Gemini API provider adapter — Foundation Phase placeholder (health_only).
//
// `gemini-api` exposes no first-party quota endpoint; the v1.1 adapter
// will perform a lightweight reachability + auth check against the
// Gemini REST endpoint and emit a `kind: 'health'` snapshot. v1 returns
// the `unsupported` placeholder so the dispatcher path is exercised
// end-to-end without any outbound traffic.

import type { ProviderAdapter } from './types';

export const geminiApiAdapter: ProviderAdapter = {
  provider: 'gemini-api',
  capability: 'health_only',
  async refresh({ account, now }) {
    return {
      provider: 'gemini-api',
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
