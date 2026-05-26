// Claude Code provider adapter — Foundation Phase placeholder.
//
// v1 returns a fixed `unsupported` snapshot. v1.1 will replace this body
// with a real call to `GET https://api.anthropic.com/api/oauth/usage`
// that decodes `five_hour`, `seven_day`, `seven_day_oauth_apps`,
// `seven_day_opus`, `seven_day_sonnet`, `seven_day_cowork` windows; see
// cpa-quota-import/design.md §v1.1 Follow-up.

import type { ProviderAdapter } from './types';

export const claudeCodeAdapter: ProviderAdapter = {
  provider: 'claude-code',
  capability: 'official',
  async refresh({ account, now }) {
    return {
      provider: 'claude-code',
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
