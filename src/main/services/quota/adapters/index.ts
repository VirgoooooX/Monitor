// Provider adapter registry — Foundation Phase.
//
// Exports the static `adapterRegistry` keyed by `ProviderId`. The map
// is exhaustive (TypeScript enforces this via `Record<ProviderId,
// ProviderAdapter>`); adding a new provider to `ProviderId` will not
// type-check until a corresponding adapter is registered here.
//
// `quota.service.ts` consumes this registry directly; tests can build
// their own `Record<ProviderId, ProviderAdapter>` to inject stubbed
// adapter behaviours without touching this module.

import type { ProviderId } from '../../../types';
import type { ProviderAdapter } from './types';
import { claudeCodeAdapter } from './claude-code.adapter';
import { codexAdapter } from './codex.adapter';
import { geminiCliAdapter } from './gemini-cli.adapter';
import { antigravityAdapter } from './antigravity.adapter';
import { geminiApiAdapter } from './gemini-api.adapter';
import { deepseekAdapter } from './deepseek.adapter';
import { xiaomiAdapter } from './xiaomi.adapter';
import { openaiCompatibleAdapter } from './openai-compatible.adapter';

export type { ProviderAdapter, ProviderAdapterRefreshInput } from './types';

export const adapterRegistry: Record<ProviderId, ProviderAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  'gemini-cli': geminiCliAdapter,
  antigravity: antigravityAdapter,
  'gemini-api': geminiApiAdapter,
  deepseek: deepseekAdapter,
  xiaomi: xiaomiAdapter,
  'openai-compatible': openaiCompatibleAdapter,
};
