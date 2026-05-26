import { describe, expect, it } from 'vitest';

import { createUsageService } from './usage.service';
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

describe('usage service provider list', () => {
  it('includes enabled configured providers even when they have no events yet', () => {
    const service = createUsageService({
      settings: createSettingsRepo(baseSettings()),
      usageEvents: {
        aggregateByProvider: () => [
          {
            provider: 'xiaomi',
            inputTokens: 11,
            outputTokens: 13,
            cacheTokens: 17,
            costUsd: null,
            eventCount: 1,
          },
        ],
      } as never,
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
});
