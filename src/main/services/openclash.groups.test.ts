import { describe, expect, it } from 'vitest';

import {
  identifyPrimaryGroup,
  resolveSelectedNode,
} from './openclash.groups';
import type { ProxiesResponse } from '../types';

function selector(
  name: string,
  now: string,
  all: string[],
): ProxiesResponse['proxies'][string] {
  return { type: 'Selector', name, now, all };
}

describe('identifyPrimaryGroup', () => {
  it('ignores GLOBAL even when it appears in preferred groups', () => {
    const proxies: ProxiesResponse = {
      proxies: {
        GLOBAL: selector('GLOBAL', 'DIRECT', ['DIRECT', 'Proxy']),
        Proxy: selector('Proxy', 'hk-01', ['DIRECT', 'hk-01', 'jp-01']),
      },
    };

    expect(identifyPrimaryGroup(proxies, ['GLOBAL', 'Proxy'])).toBe('Proxy');
  });

  it('falls back to the real Selector with the most real nodes', () => {
    const proxies: ProxiesResponse = {
      proxies: {
        GLOBAL: selector('GLOBAL', 'DIRECT', ['DIRECT', 'REJECT']),
        Small: selector('Small', 'hk-01', ['DIRECT', 'hk-01']),
        Large: selector('Large', 'jp-01', [
          'DIRECT',
          'hk-01',
          'jp-01',
          'sg-01',
        ]),
      },
    };

    expect(identifyPrimaryGroup(proxies, [])).toBe('Large');
  });

  it('returns null when only pseudo-node groups are available', () => {
    const proxies: ProxiesResponse = {
      proxies: {
        GLOBAL: selector('GLOBAL', 'DIRECT', ['DIRECT', 'REJECT', 'GLOBAL']),
      },
    };

    expect(identifyPrimaryGroup(proxies, ['GLOBAL'])).toBeNull();
  });
});

describe('resolveSelectedNode', () => {
  it('follows nested selector groups to the final leaf node', () => {
    const proxies: ProxiesResponse = {
      proxies: {
        GLOBAL: selector('GLOBAL', 'SS', ['DIRECT', 'SS']),
        SS: selector('SS', 'CN 台湾A01 | IEPL | x2', [
          'DIRECT',
          'CN 台湾A01 | IEPL | x2',
          'JP 东京A01',
        ]),
        'CN 台湾A01 | IEPL | x2': {
          type: 'Shadowsocks',
          name: 'CN 台湾A01 | IEPL | x2',
        },
      },
    };

    expect(resolveSelectedNode(proxies, 'GLOBAL')).toEqual({
      groupName: 'SS',
      nodeName: 'CN 台湾A01 | IEPL | x2',
    });
  });

  it('returns null when the resolved selection is a pseudo node', () => {
    const proxies: ProxiesResponse = {
      proxies: {
        Proxy: selector('Proxy', 'DIRECT', ['DIRECT', 'CN 台湾A01 | IEPL | x2']),
      },
    };

    expect(resolveSelectedNode(proxies, 'Proxy')).toBeNull();
  });
});
