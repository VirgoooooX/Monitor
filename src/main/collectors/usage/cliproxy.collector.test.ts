// SKIPPED for cpa-quota-import Foundation Phase: createCliProxyCollector is OUT OF SCOPE for v1 and will be reintroduced in the v1.1 spec that lands cliproxy.collector.ts.
import { describe, expect, it } from 'vitest';

// NOTE: The import below is intentionally commented out — the source module
// `./cliproxy.collector` does not exist in the Foundation Phase. The v1.1
// spec will reintroduce it together with the un-skipped tests.
// import { createCliProxyCollector } from './cliproxy.collector';
const createCliProxyCollector: any = undefined;

describe('CLIProxy usage collector', () => {
  it.skip('imports usage queue records without persisting secret fields', async () => {
    const inserted: Array<{
      provider: string;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheTokens: number;
      sourcePath: string;
      eventId: string | null;
    }> = [];

    const collector = createCliProxyCollector({
      enabled: true,
      managementUrl: 'http://127.0.0.1:8317',
      authDir: 'C:\\Users\\tester\\.cli-proxy-api',
      usageQueueBatchSize: 10,
      getSecret: () => 'management-key',
      fetch: async (url: string, init: { headers: { Authorization: string } }) => {
        expect(url).toBe('http://127.0.0.1:8317/v0/management/usage-queue?count=10');
        expect(init.headers.Authorization).toBe('Bearer management-key');
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              timestamp: '2026-05-26T07:30:00.000Z',
              provider: 'xiaomi',
              model: 'mimo-v2.5-pro',
              alias: 'mimo',
              endpoint: 'POST /v1/chat/completions',
              request_id: 'req_xiaomi_1',
              api_key: 'sk-should-not-be-stored',
              tokens: {
                input_tokens: 100,
                output_tokens: 35,
                cached_tokens: 12,
                reasoning_tokens: 4,
                total_tokens: 151,
              },
            },
          ],
        };
      },
    });

    await collector.tick({
      now: () => 1_779_750_000_000,
      usageEvents: {
        insertIgnore(event: {
          provider: string;
          model: string | null;
          inputTokens: number;
          outputTokens: number;
          cacheTokens: number;
          sourcePath: string;
          eventId: string | null;
        }) {
          inserted.push(event);
          return true;
        },
        watermark: () => null,
      } as never,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      inputTokens: 100,
      outputTokens: 35,
      cacheTokens: 12,
      sourcePath: 'POST /v1/chat/completions',
      eventId: 'req_xiaomi_1',
    });
    expect(JSON.stringify(inserted)).not.toContain('sk-should-not-be-stored');
  });
});
