import { describe, expect, it } from 'vitest';

import { createDashboardService } from './dashboard.service';
import type { Repositories, NetworkSampleRow } from '../store/repositories';

function networkSample(
  partial: Partial<NetworkSampleRow> & Pick<NetworkSampleRow, 'layer' | 'ok'>,
): NetworkSampleRow {
  return {
    id: 1,
    timestamp: 1_000,
    target: 'https://example.com',
    latencyMs: partial.ok ? 120 : null,
    error: partial.ok ? null : 'timeout',
    ...partial,
  };
}

function createRepos(overrides?: {
  latestOkGroup?: string | null;
  latestOkNode?: string | null;
  probeRows?: NetworkSampleRow[];
}): Repositories {
  const latestOkGroup = overrides?.latestOkGroup ?? null;
  const latestOkNode = overrides?.latestOkNode ?? null;
  const probeRows = overrides?.probeRows ?? [];

  return {
    networkSamples: {
      latestForLayer(layer) {
        if (layer === 'controller_tcp') {
          return networkSample({ layer, ok: true });
        }
        return undefined;
      },
      recentForLayer(layer) {
        if (layer === 'router') {
          return [networkSample({ layer, ok: true })];
        }
        if (layer === 'probe') {
          return probeRows;
        }
        return [];
      },
    },
    openClashSnapshots: {
      latest() {
        return {
          id: 1,
          timestamp: 1_000,
          apiOk: true,
          mode: 'rule',
          groupName: latestOkGroup,
          nodeName: latestOkNode,
          status: 'ok',
        };
      },
      latestOk() {
        return {
          id: 1,
          timestamp: 1_000,
          apiOk: true,
          mode: 'rule',
          groupName: latestOkGroup,
          nodeName: latestOkNode,
          status: 'ok',
        };
      },
    },
    usageEvents: {
      aggregateByProvider() {
        return [];
      },
    },
  } as unknown as Repositories;
}

describe('dashboard service', () => {
  it('does not surface GLOBAL · DIRECT as the current real node', () => {
    const service = createDashboardService({
      repositories: createRepos({
        latestOkGroup: 'GLOBAL',
        latestOkNode: 'DIRECT',
      }),
      getControllerUrl: () => 'http://127.0.0.1:9090',
      getProbeUrls: () => ['https://example.com'],
      now: () => 2_000,
    });

    const state = service.compute();

    expect(state.currentNode.group).toBeNull();
    expect(state.currentNode.node).toBeNull();
  });

  it('surfaces the resolved leaf node from a nested selector snapshot', () => {
    const service = createDashboardService({
      repositories: createRepos({
        latestOkGroup: 'SS',
        latestOkNode: 'CN 台湾A01 | IEPL | x2',
      }),
      getControllerUrl: () => 'http://127.0.0.1:9090',
      getProbeUrls: () => ['https://example.com'],
      now: () => 2_000,
    });

    const state = service.compute();

    expect(state.currentNode.group).toBe('SS');
    expect(state.currentNode.node).toBe('CN 台湾A01 | IEPL | x2');
  });

  it('uses recent probe rows when the current tick has no probe results', () => {
    const service = createDashboardService({
      repositories: createRepos({
        latestOkGroup: 'Proxy',
        latestOkNode: 'hk-01',
        probeRows: [networkSample({ layer: 'probe', ok: true })],
      }),
      getControllerUrl: () => 'http://127.0.0.1:9090',
      getProbeUrls: () => ['https://example.com'],
      now: () => 2_000,
    });

    const state = service.compute();

    expect(state.currentNode.probeResults).toEqual([
      { url: 'https://example.com', ok: true, latencyMs: 120 },
    ]);
  });
});
