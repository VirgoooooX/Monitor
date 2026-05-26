// DeepSeek provider adapter — Foundation Phase placeholder (health_only).
//
// Per the Q1 resolution in cpa-quota-import/design.md, DeepSeek's local
// balance accounting stays in `usage.service.ts` via the existing
// `deepseek.collector.ts` path; the quota aggregator only needs to
// confirm the `/user/balance` endpoint is reachable. v1 returns the
// `unsupported` placeholder so the dispatcher path is exercised
// end-to-end without any outbound traffic.

import type { ProviderAdapter } from './types';

export const deepseekAdapter: ProviderAdapter = {
  provider: 'deepseek',
  capability: 'health_only',
  async refresh({ account, now }) {
    return {
      provider: 'deepseek',
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
