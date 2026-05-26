import {
  createGoogleCodeAssistAdapter,
  type GoogleCodeAssistAdapterDeps,
} from './google-code-assist';
import type { ProviderAdapter } from './types';

export function createAntigravityAdapter(
  deps: GoogleCodeAssistAdapterDeps = {},
): ProviderAdapter {
  return createGoogleCodeAssistAdapter(
    {
      provider: 'antigravity',
      bases: [
        'https://daily-cloudcode-pa.googleapis.com',
        'https://daily-cloudcode-pa.sandbox.googleapis.com',
        'https://cloudcode-pa.googleapis.com',
      ],
      ideType: 'ANTIGRAVITY',
      userAgent: 'antigravity',
      xGoogApiClient: 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      actions: ['fetchAvailableModels', 'loadCodeAssist'],
    },
    deps,
  );
}

export const antigravityAdapter: ProviderAdapter = createAntigravityAdapter();
