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
      compactTheme: 'mint-monitor',
      fontScale: 1,
      compactZoom: 1,
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
  it('omits collector toggle keys when no provider_auth row backs them', () => {
    // Settings declare `qwen` / `kimi` / `xiaomi` as enabled
    // collectors but no `provider_auth` rows back them. Per the AI
    // Accounts unification (planning doc §Renderer UI 设计) the
    // legacy `settings.collectors` map MUST NOT make a provider
    // appear in the summary. Aggregated usage events are still
    // counted (the events themselves were captured before the
    // unification), but the row is hidden until an account is
    // imported.
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
      providerAuth: createProviderAuthRepoStub([]),
      now: () => new Date('2026-05-26T08:00:00+08:00').getTime(),
    });

    const summary = service.getUsageSummary({ range: 'today' });
    const providers = summary.perProvider.map((p) => p.provider);

    expect(providers).not.toContain('qwen');
    expect(providers).not.toContain('kimi');
    expect(providers).not.toContain('xiaomi');
    expect(providers).not.toContain('codex');
  });

  it('includes enabled provider_auth rows even with no events yet', () => {
    // An imported `provider_auth` row surfaces in the summary even
    // before any usage events land — empty-event defaults (zero
    // totals) still let the renderer display the account.
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
      enabled: true,
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
    expect(summary.perProvider.find((p) => p.provider === 'gemini-cli')).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      eventCount: 0,
    });
  });

  it('hides disabled provider_auth rows from the summary', () => {
    // `enabled: false` means the user paused the account; the
    // summary MUST NOT surface it (planning doc §Backend 刷新).
    // Disabled rows still live in `provider_auth` so the user can
    // re-enable them, but the usage panel treats them as gone.
    const importedAt = new Date('2026-05-20T10:00:00+08:00').getTime();
    const disabledRow: ProviderAuthRow = {
      id: '00000000-0000-4000-8000-000000000002',
      provider: 'deepseek',
      label: 'deepseek:paused',
      source: 'manual-api-key',
      accountId: null,
      projectId: null,
      quotaCapability: 'health_only',
      importedAt,
      updatedAt: importedAt,
      lastValidatedAt: null,
      lastQuotaAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      enabled: false,
      secretKey: 'cpaAuth.providerAuth.00000000-0000-4000-8000-000000000002',
    };

    const service = createUsageService({
      settings: createSettingsRepo(baseSettings()),
      usageEvents: createUsageEventsRepoStub([
        {
          provider: 'deepseek',
          inputTokens: 5,
          outputTokens: 0,
          cacheTokens: 0,
          costUsd: null,
          eventCount: 1,
        },
      ]),
      providerAuth: createProviderAuthRepoStub([disabledRow]),
      now: () => new Date('2026-05-26T08:00:00+08:00').getTime(),
    });

    const summary = service.getUsageSummary({ range: 'today' });
    const providers = summary.perProvider.map((p) => p.provider);

    expect(providers).not.toContain('deepseek');
  });

  it('supplements usage from dailyUsage when no events exist', () => {
    const importedAt = new Date('2026-05-20T10:00:00+08:00').getTime();
    const deepseekRow: ProviderAuthRow = {
      id: '00000000-0000-4000-8000-000000000002',
      provider: 'deepseek',
      label: 'deepseek:active',
      source: 'manual-api-key',
      accountId: null,
      projectId: null,
      quotaCapability: 'health_only',
      importedAt,
      updatedAt: importedAt,
      lastValidatedAt: null,
      lastQuotaAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      enabled: true,
      secretKey: 'cpaAuth.providerAuth.00000000-0000-4000-8000-000000000002',
    };

    const mockSnapshots = [
      {
        provider: 'deepseek',
        capturedAt: importedAt,
        source: 'imported_auth' as const,
        windows: [],
        providerAuthId: '00000000-0000-4000-8000-000000000002',
        accountLabel: 'deepseek:active',
        accountId: null,
        projectId: null,
        kind: 'health' as const,
        status: 'ok' as const,
        rawPlanLabel: null,
        modelGroup: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        dailyUsage: [
          { date: '2026-05-26', cost: '0.0125', totalTokens: 1000 },
          { date: '2026-05-25', cost: '0.005', totalTokens: 500 },
        ],
      },
    ];

    const service = createUsageService({
      settings: createSettingsRepo(baseSettings()),
      usageEvents: createUsageEventsRepoStub([]), // No events
      providerAuth: createProviderAuthRepoStub([deepseekRow]),
      quotaSnapshots: () => mockSnapshots,
      now: () => new Date('2026-05-26T08:00:00+08:00').getTime(), // This is today, bounds for today starts at 2026-05-26 00:00
    });

    const summary = service.getUsageSummary({ range: 'today' });
    const dsSummary = summary.perProvider.find((p) => p.provider === 'deepseek');
    expect(dsSummary).toBeDefined();
    expect(dsSummary!.source).toBe('quotaDailyUsage');
    expect(dsSummary!.inputTokens).toBe(1000); // Only 2026-05-26 falls in today's bounds
    expect(dsSummary!.hasTokenBreakdown).toBe(false);
    expect(dsSummary!.costUsd).toBeCloseTo(0.0125);
  });

  it('sets source=events and computes hasTokenBreakdown correctly', () => {
    const importedAt = new Date('2026-05-20T10:00:00+08:00').getTime();
    const deepseekRow: ProviderAuthRow = {
      id: '00000000-0000-4000-8000-000000000002',
      provider: 'deepseek',
      label: 'deepseek:active',
      source: 'manual-api-key',
      accountId: null,
      projectId: null,
      quotaCapability: 'health_only',
      importedAt,
      updatedAt: importedAt,
      lastValidatedAt: null,
      lastQuotaAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      enabled: true,
      secretKey: 'cpaAuth.providerAuth.00000000-0000-4000-8000-000000000002',
    };

    const service = createUsageService({
      settings: createSettingsRepo(baseSettings()),
      usageEvents: createUsageEventsRepoStub([
        {
          provider: 'deepseek',
          inputTokens: 10,
          outputTokens: 5,
          cacheTokens: 0,
          costUsd: null,
          eventCount: 1,
        },
      ]),
      providerAuth: createProviderAuthRepoStub([deepseekRow]),
      now: () => new Date('2026-05-26T08:00:00+08:00').getTime(),
    });

    const summary = service.getUsageSummary({ range: 'today' });
    const dsSummary = summary.perProvider.find((p) => p.provider === 'deepseek');
    expect(dsSummary).toBeDefined();
    expect(dsSummary!.source).toBe('events');
    expect(dsSummary!.hasTokenBreakdown).toBe(true);
    expect(dsSummary!.inputTokens).toBe(10);
  });
});
