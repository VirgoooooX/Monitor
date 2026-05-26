// Unit tests for diagnostics redaction (cpa-quota-import task 13.2).
//
// Validates:
//   - Requirement 1.4 (no token, refresh token, API key, or full URL
//     substrings in any IPC / diagnostics output).
//   - Requirement 13.4 (`getDiagnostics` projects every `provider_auth`
//     row through the redacted whitelist defined by `diagnosticsRow`;
//     `label`, `accountId`, and `projectId` are deliberately omitted).
//
// Strategy: hand-built stub `ProviderAuthRepository`, stub
// `SettingsRepository`, stub `CollectorHealthRepository`, plus a
// `getSecretValues` source that surfaces a token, a refresh token,
// and an API key. We then call `service.export()` and assert:
//   1. `report.providerAuthAccounts.length === <row count>`.
//   2. Each entry exposes only the documented fields.
//   3. `JSON.stringify(report)` does not contain any of the simulated
//      secret values.
//   4. `JSON.stringify(report)` does not contain the row labels,
//      accountIds, or projectIds (these semi-sensitive columns are
//      filtered by the `diagnosticsRow` projection — Q5 resolution).

import { describe, expect, it } from 'vitest';

import { createDiagnosticsService } from './diagnostics.service';
import type {
  CollectorHealthRepository,
  CollectorHealthRow,
  ProviderAuthRepository,
  ProviderAuthRow,
  SettingsRepository,
} from '../store/repositories';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Realistic-looking secret values that would be present in a parsed
 * Secret_Payload. Each is long enough and distinctive enough that a
 * stray substring leak would be detectable in the JSON-stringified
 * report.
 */
const SECRET_VALUES = {
  codexAccessToken:
    'eyJhbGciOiJIUzI1NiJ9.codex-access-token-payload-deadbeef',
  codexRefreshToken: 'rt_codex_9f8e7d6c5b4a39281706abcdef123456',
  geminiApiKey: 'AIzaSyA-DEMO-GEMINI-API-KEY-EXAMPLE-123456',
  fullEndpointUrl:
    'https://api.example-provider.test/v1/auth?token=should-not-appear',
} as const;

/**
 * Secret values flattened into the array shape `getSecretValues`
 * exposes. Order is irrelevant — the redaction sieve uses a `Set`.
 */
const SIMULATED_SECRETS: readonly string[] = Object.values(SECRET_VALUES);

/**
 * Row 1 — Codex (ChatGPT) account.
 *
 * `label` carries an email, `accountId` and `projectId` carry
 * provider-side identifiers. None of these should reach the
 * diagnostics output even though they are non-secret.
 */
const ROW_CODEX: ProviderAuthRow = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'codex',
  label: 'codex:user@example.com',
  source: 'cpa-auth-file',
  accountId: 'acc_codex_001_personal',
  projectId: null,
  quotaCapability: 'official',
  importedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  lastValidatedAt: 1_700_000_002_000,
  lastQuotaAt: 1_700_000_003_000,
  lastErrorCode: null,
  lastErrorMessage: null,
  secretKey: 'cpaAuth.providerAuth.11111111-1111-4111-8111-111111111111',
};

/**
 * Row 2 — Gemini CLI account with a populated `projectId` so we can
 * assert it is filtered out of the diagnostics output.
 */
const ROW_GEMINI_CLI: ProviderAuthRow = {
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'gemini-cli',
  label: 'gemini-cli:dev@example.com',
  source: 'cpa-auth-file',
  accountId: 'acc_gemini_002_workspace',
  projectId: 'gcp-project-staging-987654',
  quotaCapability: 'health_only',
  importedAt: 1_700_000_010_000,
  updatedAt: 1_700_000_011_000,
  lastValidatedAt: 1_700_000_012_000,
  lastQuotaAt: null,
  lastErrorCode: 'auth_expired',
  lastErrorMessage: 'token expired',
  secretKey: 'cpaAuth.providerAuth.22222222-2222-4222-8222-222222222222',
};

/**
 * Row 3 — DeepSeek API-key account.
 */
const ROW_DEEPSEEK: ProviderAuthRow = {
  id: '33333333-3333-4333-8333-333333333333',
  provider: 'deepseek',
  label: 'deepseek:billing@example.com',
  source: 'cpa-auth-file',
  accountId: null,
  projectId: null,
  quotaCapability: 'official',
  importedAt: 1_700_000_020_000,
  updatedAt: 1_700_000_021_000,
  lastValidatedAt: null,
  lastQuotaAt: null,
  lastErrorCode: 'auth_missing',
  lastErrorMessage: 'api key missing from imported payload',
  secretKey: 'cpaAuth.providerAuth.33333333-3333-4333-8333-333333333333',
};

const ALL_ROWS: readonly ProviderAuthRow[] = [
  ROW_CODEX,
  ROW_GEMINI_CLI,
  ROW_DEEPSEEK,
];

// ---------------------------------------------------------------------------
// Stub repositories
// ---------------------------------------------------------------------------

/**
 * Minimal `SettingsRepository` stub. The diagnostics service reads
 * the canonical `AppSettings` blob (for `controllerUrl` and the
 * management interface summary) plus the persisted capability map;
 * for this redaction-focused test we keep both empty so the report
 * surface is dominated by `providerAuthAccounts`.
 */
function buildSettingsStub(): SettingsRepository {
  const store = new Map<string, unknown>();
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
      return [...store.keys()].sort();
    },
    entries(): Array<{ key: string; value: unknown }> {
      return [...store.entries()].map(([key, value]) => ({ key, value }));
    },
  };
}

function buildCollectorHealthStub(): CollectorHealthRepository {
  return {
    upsert: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    get: () => undefined,
    list: (): CollectorHealthRow[] => [],
  };
}

/**
 * `ProviderAuthRepository` stub that returns the supplied rows
 * verbatim. Only `list()` is used by the diagnostics service; the
 * other methods are present to satisfy the interface and throw if
 * accidentally exercised so a regression in the diagnostics service
 * (e.g. switching to `listByProvider`) is loud.
 */
function buildProviderAuthStub(
  rows: readonly ProviderAuthRow[],
): ProviderAuthRepository {
  return {
    list: () => rows.map((r) => ({ ...r })),
    listByProvider: () => {
      throw new Error(
        'diagnostics.service must not call listByProvider — use list',
      );
    },
    get: () => {
      throw new Error('diagnostics.service must not call get');
    },
    insert: () => {
      throw new Error('diagnostics.service must not call insert');
    },
    update: () => {
      throw new Error('diagnostics.service must not call update');
    },
    remove: () => {
      throw new Error('diagnostics.service must not call remove');
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diagnostics.service — provider_auth redaction (task 13.2)', () => {
  it('exposes one redacted entry per provider_auth row', () => {
    const service = createDiagnosticsService({
      settings: buildSettingsStub(),
      collectorHealth: buildCollectorHealthStub(),
      providerAuth: buildProviderAuthStub(ALL_ROWS),
      getSecretValues: () => [...SIMULATED_SECRETS],
    });

    const report = service.export();

    // (1) Output array length equals row count.
    expect(report.providerAuthAccounts).toHaveLength(ALL_ROWS.length);
  });

  it('each entry surfaces only the documented diagnostics fields', () => {
    const service = createDiagnosticsService({
      settings: buildSettingsStub(),
      collectorHealth: buildCollectorHealthStub(),
      providerAuth: buildProviderAuthStub(ALL_ROWS),
      getSecretValues: () => [...SIMULATED_SECRETS],
    });

    const report = service.export();

    const ALLOWED_KEYS: ReadonlySet<string> = new Set([
      'id',
      'provider',
      'quotaCapability',
      'lastErrorCode',
      'lastQuotaAt',
      'lastValidatedAt',
    ]);

    for (let i = 0; i < ALL_ROWS.length; i++) {
      const entry = report.providerAuthAccounts[i]!;
      const sourceRow = ALL_ROWS[i]!;

      // Exact-key check: no `label`, `accountId`, `projectId`,
      // `importedAt`, `updatedAt`, `lastErrorMessage`, or — most
      // importantly — `secretKey`.
      expect(new Set(Object.keys(entry))).toEqual(ALLOWED_KEYS);

      // Spot-check the surfaced values come from the source row.
      expect(entry.id).toBe(sourceRow.id);
      expect(entry.provider).toBe(sourceRow.provider);
      expect(entry.quotaCapability).toBe(sourceRow.quotaCapability);
      expect(entry.lastErrorCode).toBe(sourceRow.lastErrorCode);
      expect(entry.lastQuotaAt).toBe(sourceRow.lastQuotaAt);
      expect(entry.lastValidatedAt).toBe(sourceRow.lastValidatedAt);
    }
  });

  it('JSON.stringify(report) contains no simulated secret values', () => {
    const service = createDiagnosticsService({
      settings: buildSettingsStub(),
      collectorHealth: buildCollectorHealthStub(),
      providerAuth: buildProviderAuthStub(ALL_ROWS),
      getSecretValues: () => [...SIMULATED_SECRETS],
    });

    const report = service.export();
    const json = JSON.stringify(report);

    // No token, refresh token, API key, or full URL substrings.
    for (const secret of SIMULATED_SECRETS) {
      expect(json).not.toContain(secret);
    }
  });

  it('JSON.stringify(report) contains no label, accountId, or projectId values', () => {
    const service = createDiagnosticsService({
      settings: buildSettingsStub(),
      collectorHealth: buildCollectorHealthStub(),
      providerAuth: buildProviderAuthStub(ALL_ROWS),
      getSecretValues: () => [...SIMULATED_SECRETS],
    });

    const report = service.export();
    const json = JSON.stringify(report);

    for (const row of ALL_ROWS) {
      // `label` is always populated.
      expect(json).not.toContain(row.label);
      // `accountId` / `projectId` may be null; only assert when set.
      if (row.accountId !== null) {
        expect(json).not.toContain(row.accountId);
      }
      if (row.projectId !== null) {
        expect(json).not.toContain(row.projectId);
      }
      // `secretKey` MUST never appear either — defence in depth.
      expect(json).not.toContain(row.secretKey);
    }
  });

  it('returns an empty providerAuthAccounts array when the dep is omitted', () => {
    // Sanity: the diagnostics service treats `providerAuth` as
    // optional (matches the field's contract). When omitted, the
    // surfaced array is empty rather than `undefined`.
    const service = createDiagnosticsService({
      settings: buildSettingsStub(),
      collectorHealth: buildCollectorHealthStub(),
      getSecretValues: () => [...SIMULATED_SECRETS],
    });

    const report = service.export();
    expect(report.providerAuthAccounts).toEqual([]);
  });
});
