// Auto-discovery unit tests.
//
// Validates the contract laid out in `auth-file.discovery.ts`:
//
//   - Probes that find a parseable credential get a fresh
//     `provider_auth` row inserted with `enabled: true` and the
//     `(自动发现)` label suffix.
//   - Probes whose file is missing increment the `missing` counter
//     and never write rows.
//   - Probes whose file is unparseable increment `failed` without
//     stopping the rest of the scan.
//   - Probes whose credential matches an existing row's secret
//     fingerprint are silently skipped — re-running the scan after
//     a previous import is a no-op.

import { describe, it, expect } from 'vitest';

import { runDiscovery } from './auth-file.discovery';
import type {
  ProviderAuthRepository,
  ProviderAuthRow,
} from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';
import type { ProviderId } from '../types';

// ---------------------------------------------------------------------------
// In-memory test doubles
// ---------------------------------------------------------------------------

function createMemRepo(): ProviderAuthRepository {
  const rows = new Map<string, ProviderAuthRow>();
  return {
    list: () => Array.from(rows.values()),
    listByProvider: (p) =>
      Array.from(rows.values()).filter((r) => r.provider === p),
    get: (id) => rows.get(id) ?? null,
    insert: (row) => {
      if (rows.has(row.id)) {
        throw new Error(`duplicate id ${row.id}`);
      }
      rows.set(row.id, { ...row });
    },
    update: (id, patch) => {
      const r = rows.get(id);
      if (!r) return;
      rows.set(id, { ...r, ...patch });
    },
    remove: (id) => {
      rows.delete(id);
    },
  };
}

function createMemSecrets(): SecretsAdmin {
  const store = new Map<string, string>();
  return {
    set: (k, v) => {
      store.set(k, v);
    },
    get: (k) => store.get(k) ?? null,
    remove: (k) => {
      store.delete(k);
    },
  } as SecretsAdmin;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CODEX_AUTH = JSON.stringify({
  metadata: {
    access_token: 'sk-codex-AAA',
    account_id: 'codex-account-1',
  },
});

const CODEX_NATIVE_AUTH = JSON.stringify({
  // Mirrors the on-disk shape Codex CLI writes to `~/.codex/auth.json`.
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'id-jwt',
    access_token: 'sk-codex-NATIVE',
    refresh_token: 'rt-codex-NATIVE',
    account_id: 'codex-account-native',
  },
  last_refresh: '2025-01-01T00:00:00.000Z',
});

const CLAUDE_AUTH = JSON.stringify({
  metadata: {
    access_token: 'sk-ant-BBB',
  },
});

const CLAUDE_NATIVE_AUTH = JSON.stringify({
  // Mirrors the on-disk shape Claude Code writes to
  // `~/.claude/.credentials.json`.
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-NATIVE',
    refreshToken: 'sk-ant-ort01-NATIVE',
    expiresAt: 1_900_000_000_000,
    scopes: ['user:inference'],
  },
});

const MALFORMED_AUTH = '{not actually json';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDiscovery', () => {
  it('imports new credentials with enabled=true and a (自动发现) label', async () => {
    const repo = createMemRepo();
    const secrets = createMemSecrets();
    const probes = [
      { provider: 'codex' as ProviderId, filePath: '/fake/codex.json' },
      { provider: 'claude-code' as ProviderId, filePath: '/fake/claude.json' },
    ];
    const files = new Map<string, string>([
      ['/fake/codex.json', CODEX_AUTH],
      ['/fake/claude.json', CLAUDE_AUTH],
    ]);

    let n = 0;
    const report = await runDiscovery({
      providerAuthRepo: repo,
      secrets,
      probes,
      fileExists: async (p) => files.has(p),
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error('missing');
        return v;
      },
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => 1_700_000_000_000,
    });

    expect(report).toEqual({ imported: 2, skipped: 0, failed: 0, missing: 0 });
    const rows = repo.list();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.enabled).toBe(true);
      expect(r.source).toBe('cpa-auth-file');
      expect(r.label.endsWith('(自动发现)')).toBe(true);
    }
  });

  it('counts missing files without writing rows', async () => {
    const repo = createMemRepo();
    const secrets = createMemSecrets();
    const probes = [
      { provider: 'codex' as ProviderId, filePath: '/missing/codex.json' },
    ];

    const report = await runDiscovery({
      providerAuthRepo: repo,
      secrets,
      probes,
      fileExists: async () => false,
      readFile: async () => {
        throw new Error('should not read');
      },
    });

    expect(report).toEqual({ imported: 0, skipped: 0, failed: 0, missing: 1 });
    expect(repo.list()).toHaveLength(0);
  });

  it('counts unparseable files as failed and continues with the rest', async () => {
    const repo = createMemRepo();
    const secrets = createMemSecrets();
    const probes = [
      { provider: 'codex' as ProviderId, filePath: '/bad/codex.json' },
      { provider: 'claude-code' as ProviderId, filePath: '/good/claude.json' },
    ];
    const files = new Map<string, string>([
      ['/bad/codex.json', MALFORMED_AUTH],
      ['/good/claude.json', CLAUDE_AUTH],
    ]);

    const report = await runDiscovery({
      providerAuthRepo: repo,
      secrets,
      probes,
      fileExists: async (p) => files.has(p),
      readFile: async (p) => files.get(p) ?? '',
      uuid: () => '00000000-0000-4000-8000-000000000001',
      now: () => 1_700_000_000_000,
    });

    expect(report.failed).toBe(1);
    expect(report.imported).toBe(1);
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('claude-code');
  });

  it('skips a probe whose credential matches an existing row', async () => {
    const repo = createMemRepo();
    const secrets = createMemSecrets();
    // Pre-seed the repo + secrets with a Codex row that already
    // carries the same access token as the probe will yield.
    const existingId = '00000000-0000-4000-8000-eeeeeeeeeeee';
    const existingKey = `cpaAuth.providerAuth.${existingId}`;
    secrets.set(
      existingKey,
      JSON.stringify({ accessToken: 'sk-codex-AAA' }),
    );
    repo.insert({
      id: existingId,
      provider: 'codex',
      label: 'codex:existing',
      source: 'cpa-auth-file',
      accountId: 'codex-account-1',
      projectId: null,
      quotaCapability: 'official',
      importedAt: 1,
      updatedAt: 1,
      lastValidatedAt: null,
      lastQuotaAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      enabled: true,
      secretKey: existingKey,
    });

    const probes = [
      { provider: 'codex' as ProviderId, filePath: '/fake/codex.json' },
    ];
    const files = new Map<string, string>([['/fake/codex.json', CODEX_AUTH]]);

    const report = await runDiscovery({
      providerAuthRepo: repo,
      secrets,
      probes,
      fileExists: async (p) => files.has(p),
      readFile: async (p) => files.get(p) ?? '',
      uuid: () => '00000000-0000-4000-8000-000000000001',
      now: () => 1_700_000_000_000,
    });

    expect(report).toEqual({ imported: 0, skipped: 1, failed: 0, missing: 0 });
    expect(repo.list()).toHaveLength(1);
  });

  it('deduplicates two probes that resolve to the same fingerprint within one scan', async () => {
    const repo = createMemRepo();
    const secrets = createMemSecrets();
    // Two probe paths, byte-identical content. Only one row
    // should be written.
    const probes = [
      { provider: 'codex' as ProviderId, filePath: '/a/auth.json' },
      { provider: 'codex' as ProviderId, filePath: '/b/auth.json' },
    ];
    const files = new Map<string, string>([
      ['/a/auth.json', CODEX_AUTH],
      ['/b/auth.json', CODEX_AUTH],
    ]);

    let n = 0;
    const report = await runDiscovery({
      providerAuthRepo: repo,
      secrets,
      probes,
      fileExists: async (p) => files.has(p),
      readFile: async (p) => files.get(p) ?? '',
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => 1_700_000_000_000,
    });

    // Both probes parse successfully; one wins, the other is
    // recognised as a duplicate within the same scan and counted
    // as skipped.
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(1);
    expect(repo.list()).toHaveLength(1);
  });

  it('imports native CLI on-disk credentials (Codex + Claude Code)', async () => {
    // Regression guard for the bug where the auto-discovery scan
    // silently failed on `~/.codex/auth.json` and
    // `~/.claude/.credentials.json` because the parser priority
    // table only knew the CPA-wrapped shapes. With the native paths
    // wired in (`tokens.access_token`, `claudeAiOauth.accessToken`)
    // both files MUST surface as new rows on a fresh scan.
    const repo = createMemRepo();
    const secrets = createMemSecrets();
    const probes = [
      { provider: 'codex' as ProviderId, filePath: '/h/.codex/auth.json' },
      {
        provider: 'claude-code' as ProviderId,
        filePath: '/h/.claude/.credentials.json',
      },
    ];
    const files = new Map<string, string>([
      ['/h/.codex/auth.json', CODEX_NATIVE_AUTH],
      ['/h/.claude/.credentials.json', CLAUDE_NATIVE_AUTH],
    ]);

    let n = 0;
    const report = await runDiscovery({
      providerAuthRepo: repo,
      secrets,
      probes,
      fileExists: async (p) => files.has(p),
      readFile: async (p) => files.get(p) ?? '',
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => 1_700_000_000_000,
    });

    expect(report).toEqual({ imported: 2, skipped: 0, failed: 0, missing: 0 });
    const rows = repo.list().sort((a, b) => a.provider.localeCompare(b.provider));
    expect(rows.map((r) => r.provider)).toEqual(['claude-code', 'codex']);
    for (const r of rows) {
      expect(r.enabled).toBe(true);
      expect(r.label.endsWith('(自动发现)')).toBe(true);
    }
  });
});
