// Codex (ChatGPT) provider adapter — Foundation Phase placeholder.
//
// v1 returns a fixed `unsupported` snapshot. v1.1 will route the
// existing `fetchRemoteQuota()` helper from
// `codex-quota.collector.ts` through this adapter so it consumes a
// `Provider_Auth_Account` instead of the legacy local-log path; see
// cpa-quota-import/design.md §v1.1 Follow-up.

import type { ProviderAdapter } from './types';

export const codexAdapter: ProviderAdapter = {
  provider: 'codex',
  capability: 'official',
  async refresh({ account, now }) {
    return {
      provider: 'codex',
      capturedAt: now,
      source: 'imported_auth',
      windows: [],
      providerAuthId: account.id,
      accountLabel: account.label,
      accountId: account.accountId,
      projectId: account.projectId,
      kind: 'quota',
      status: 'unsupported',
      rawPlanLabel: null,
      modelGroup: null,
      lastErrorCode: 'unsupported',
      lastErrorMessage: 'adapter not implemented in v1',
    };
  },
};
