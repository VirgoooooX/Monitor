import {
  createGoogleCodeAssistAdapter,
  type GoogleCodeAssistAdapterDeps,
} from './google-code-assist';
import type { ProviderAdapter } from './types';

export function createGeminiCliAdapter(
  deps: GoogleCodeAssistAdapterDeps = {},
): ProviderAdapter {
  return createGoogleCodeAssistAdapter(
    {
      provider: 'gemini-cli',
      bases: ['https://cloudcode-pa.googleapis.com'],
      ideType: 'GEMINI_CLI',
      userAgent: 'gemini-cli',
      actions: ['retrieveUserQuota', 'loadCodeAssist'],
    },
    deps,
  );
}

export const geminiCliAdapter: ProviderAdapter = createGeminiCliAdapter();
