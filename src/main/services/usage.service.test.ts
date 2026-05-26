import { describe, expect, it } from 'vitest';

import { createUsageService } from './usage.service';
import type {
  ProviderAuthRepository,
  ProviderAuthRow,
  ProviderUsageAggregate,
  UsageEventRow,
  UsageEventsRepository,
  UsageRangeBounds,
} from '../store/repositories';
import type { AppSettings } from '../types';

function baseSettings(): AppSettings {
  return {
    controllerUrl: 'http://127.0.0.1:9090',
    primaryGroups: ['Proxy'],
    probeUrls: ['https://example.com'],
    routerHealth: { host: '127.0.0.1', port: 22 },
    switchVerifyDelayMs: 1000,
    switchConfirmation: false,
    refreshIntervals: {
      networkMs: 3000,
      openclashMs: 3000,
      currentNodeMs: 10_000,
      nodeScanMs: 60_000,
      usageMs: 60_000,
      retentionMs: 3_600_000,
    },
    collectors: {
      codex: { enabled: true },
      qwen: { enabled: true },
      kimi: { enabled: true },
      xiaomi: { enabled: true },
    },
    cliproxy: {
      enabled: true,
      managementUrl: 'http://127.0.0.1:8317',
      authDir: 'C:\\Users\\tester\\.cli-proxy-api',
      usageQueueBatchSize: 25,
    },
    autostart: false,
    configSwitchVerifyWindowMs: 8000,
    managementInterface: {
      kind: 'openclash-luci',
      url: 'http://127.0.0.1',
      requestTimeoutMs: 10_000,
      configFileWhitelist: [],
    },
    appearance: {
      colorMode: 'dark',
      compactTheme: 'obsidian-glass',
      fontScale: 1,
    },
  };
}

function createSettingsRepo(settings: AppSettings) {
  const store = new Map<string, unknown>([['app.settings', settings]]);
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      store.set(key, value);
    },
    remove(key: string): void {
      store.delete(key);
    },
    keys(): string[] {
      return Array.from(store.keys());
    },
    entries(): Array<{ key: string; value: unknown }> {
      return Array.from(store.entries()).map(([key, value]) => ({ key, value }));
    },
  };
}

/**
 * Minimal `UsageEventsRepository` stub. Only `aggregateByProvider`
 * is exercised by `getUsageSummary`; the rest are no-op throws so an
 * accidental call surfaces loudly instead of silently returning
 * fake data.
 */
function createUsageEventsRepoStub(
  aggregates: ProviderUsageAggregate[],
): UsageEventsRepository {
  return {
    aggregateByProvider(_bounds: UsageRangeBounds): ProviderUsageAggregate[] {
      return aggregates;
    },
    insertIgnore(): boolean {
      throw new Error('insertIgnore is not used by getUsageSummary');
    },
    watermark(): number | null {
      throw new Error('watermark is not used by getUsageSummary');
    },
    aggregateForProvider(provider: string): ProviderUsageAggregate {
      return (
        aggregates.find((a) => a.provider === provider) ?? {
          provider,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          costUsd: null,
          eventCount: 0,
        }
      );
    },
    recentForProvider(): UsageEventRow[] {
      return [];
    },
  };
}

/**
 * Minimal `ProviderAuthRepository` stub returning a fixed row list.
 * Mutating methods throw so a regression that calls into them via the
 * usage path surfaces immediately.
 */
function createProviderAuthRepoStub(
  rows: ProviderAuthRow[],
): ProviderAuthRepository {
  return {
    list: () => rows,
    listByProvider: (provider) => rows.filter((r) => r.provider === provider),
    get: (id) => rows.find((r) => r.id === id) ?? null,
    insert() {
      throw new Error('insert is not used by getUsageSummary');
    },
    update() {
      throw new Error('update is not used by getUsageSummary');
    },
    remove() {
      throw new Error('remove is not used by getUsageSummary');
    },
  };
}

describe('usage service provider list', () => {
  it('includes enabled configured providers even when they have no events yet', () => {
    // `providerAuth` is intentionally omitted — the falls-back-to
    // baseline + collectors path is what the original draft test was
    // pinning. With `exactOptionalPropertyTypes: true` enabled in
    // tsconfig, an explicit `providerAuth: undefined` would be a
    // type error, so we omit the key instead.
    const service = createUsageService({
      settings: createSettingsRepo(baseSettings()),
      usageEvents: createUsageEventsRepoStub([
        {
          provider: 'xiaomi',
          inputTokens: 11,
          outputTokens: 13,
          cacheTokens: 17,
          costUsd: null,
          eventCount: 1,
        },
      ]),
      now: () => new Date('2026-05-26T08:00:00+08:00').getTime(),
    });

    const summary = service.getUsageSummary({ range: 'today' });
    const providers = summary.perProvider.map((p) => p.provider);

    expect(providers).toContain('qwen');
    expect(providers).toContain('kimi');
    expect(providers).toContain('xiaomi');
    expect(summary.perProvider.find((p) => p.provider === 'xiaomi')).toMatchObject({
      inputTokens: 11,
      outputTokens: 13,
      cacheTokens: 17,
      eventCount: 1,
    });
  });

  it('includes provider_auth-imported providers even with no collector toggle and no events', () => {
    // Settings have no `gemini-cli` collector toggle, and the usage
    // events stub returns no row for `gemini-cli`. The provider must
    // still surface in the summary because a `provider_auth` row was
    // imported (Requirement 14.1: derived providers cover collectors
    // ∪ auth ∪ baseline).
    const importedAt = new Date('2026-05-20T10:00:00+08:00').getTime();
    const geminiCliRow: ProviderAuthRow = {
      id: '00000000-0000-4000-8000-000000000001',
      provider: 'gemini-cli',
      label: 'gemini-cli:test',
      source: 'cpa-auth-file',
      accountId: null,
      projectId: 'test-project',
      quotaCapability: 'official',
      importedAt,
      updatedAt: importedAt,
      lastValidatedAt: null,
      lastQuotaAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      secretKey: 'cpaAuth.providerAuth.00000000-0000-4000-8000-000000000001',
    };

    const service = createUsageService({
      settings: createSettingsRepo(baseSettings()),
      usageEvents: createUsageEventsRepoStub([]),
      providerAuth: createProviderAuthRepoStub([geminiCliRow]),
      now: () => new Date('2026-05-26T08:00:00+08:00').getTime(),
    });

    const summary = service.getUsageSummary({ range: 'today' });
    const providers = summary.perProvider.map((p) => p.provider);

    expect(providers).toContain('gemini-cli');
    // Empty-event default: no usage data yet, but the row is present
    // with zero totals so the renderer can still display the account.
    expect(summary.perProvider.find((p) => p.provider === 'gemini-cli')).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      eventCount: 0,
    });
  });
});
