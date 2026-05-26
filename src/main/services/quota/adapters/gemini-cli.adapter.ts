// Gemini CLI provider adapter — Foundation Phase placeholder.
//
// v1 returns a fixed `unsupported` snapshot. v1.1 will issue the
// documented `POST https://cloudcode-pa.googleapis.com/...` quota call
// using the imported account's `access_token` + `project_id`; see
// cpa-quota-import/design.md §v1.1 Follow-up.

import type { ProviderAdapter } from './types';

export const geminiCliAdapter: ProviderAdapter = {
  provider: 'gemini-cli',
  capability: 'official',
  async refresh({ account, now }) {
    return {
      provider: 'gemini-cli',
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
