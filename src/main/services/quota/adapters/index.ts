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

import type { AppSettings, KiroTokenRefreshSettings, ProviderId } from '../../../types';
import type { ProviderAdapter } from './types';
import { claudeCodeAdapter } from './claude-code.adapter';
import { codexAdapter } from './codex.adapter';
import { geminiCliAdapter } from './gemini-cli.adapter';
import { antigravityAdapter } from './antigravity.adapter';
import { createKiroIdeAdapter, kiroIdeAdapter } from './kiro-ide.adapter';
import { geminiApiAdapter } from './gemini-api.adapter';
import { deepseekAdapter } from './deepseek.adapter';
import { xiaomiAdapter } from './xiaomi.adapter';
import { opencodeAdapter } from './opencode.adapter';
import { openaiCompatibleAdapter } from './openai-compatible.adapter';

export type { ProviderAdapter, ProviderAdapterRefreshInput } from './types';

/**
 * Default registry built without runtime settings — tests and code
 * paths that don't care about the Kiro auto-refresh feature can use
 * this directly. Production wires {@link buildAdapterRegistry} from
 * `app.ts` so the Kiro adapter sees live settings.
 */
export const adapterRegistry: Record<ProviderId, ProviderAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  'gemini-cli': geminiCliAdapter,
  antigravity: antigravityAdapter,
  'kiro-ide': kiroIdeAdapter,
  'gemini-api': geminiApiAdapter,
  deepseek: deepseekAdapter,
  xiaomi: xiaomiAdapter,
  opencode: opencodeAdapter,
  'openai-compatible': openaiCompatibleAdapter,
};

/**
 * Inputs the production registry threads into the per-provider
 * adapters that need live process state (settings, secret callbacks,
 * etc.). Passing nothing falls back to the static {@link adapterRegistry}.
 */
export interface AdapterRegistryDeps {
  /**
   * Read the current `AppSettings`. Called inside the Kiro adapter
   * each time it considers a refresh, so a Settings UI toggle takes
   * effect on the next quota tick without restart.
   */
  readonly getSettings?: () => AppSettings;
}

/**
 * Build a registry that respects runtime configuration. The Kiro
 * adapter is currently the only one that consumes `getSettings` —
 * other providers reuse the singleton instance.
 */
export function buildAdapterRegistry(
  deps: AdapterRegistryDeps = {},
): Record<ProviderId, ProviderAdapter> {
  const getKiroRefreshSettings: (() => KiroTokenRefreshSettings) | undefined =
    deps.getSettings === undefined
      ? undefined
      : () => deps.getSettings!().kiroTokenRefresh;

  return {
    ...adapterRegistry,
    'kiro-ide': createKiroIdeAdapter(
      getKiroRefreshSettings === undefined
        ? {}
        : { getRefreshSettings: getKiroRefreshSettings },
    ),
  };
}
