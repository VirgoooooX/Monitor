// Feature: cpa-quota-import, Task 5.2
//
// Unit tests for `createProviderAuthService` (Task 5.1). Every
// dependency is supplied via in-memory test doubles so the service is
// exercised in isolation:
//
//   - Happy-path import (one fixture per provider) returns a redacted
//     `ProviderAuthMetadata` and writes the secret + row pair.
//   - Cancelled file dialog → `cancelled` error code, no side effects.
//   - File over 1 MiB → `parse_error`, no `secrets.set` / `repo.insert`.
//   - Unsupported extension → `unsupported_file`, no side effects.
//   - Parser throws → no row inserted, no secret written.
//   - `secrets.set` throws (`SecretsUnavailableError`) → no row inserted.
//   - `repo.insert` throws after a successful `secrets.set` → secret is
//     rolled back via `secrets.remove`.
//   - Lightweight validate flags `project_missing` for Gemini CLI /
//     Antigravity rows whose payload lacks `projectId`.
//   - `remove(id)` is idempotent (two consecutive calls succeed).
//
// References:
//   - cpa-quota-import/requirements.md Requirement 7.6, 7.7, 8.3, 8.4,
//     9.2, 11.4
//   - cpa-quota-import/design.md §Provider_Auth_Service,
//     §Import flow (happy path), §validateLightweight

import { describe, expect, it, vi } from 'vitest';

import {
  createProviderAuthService,
  ProviderAuthError,
  type ProviderAuthServiceDeps,
} from './provider_auth.service';
import type { ParseResult } from './auth-file.parser';
import { SecretsUnavailableError } from '../security/secrets';
import type {
  ProviderAuthRepository,
  ProviderAuthRow,
} from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';
import type { ProviderId } from '../types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const FIXED_UUID = '11111111-2222-3333-4444-555555555555';
const FIXED_NOW = 1_700_000_000_000;

interface HarnessOverrides {
  showOpenDialog?: ProviderAuthServiceDeps['showOpenDialog'];
  readFile?: ProviderAuthServiceDeps['readFile'];
  statFile?: ProviderAuthServiceDeps['statFile'];
  parse?: ProviderAuthServiceDeps['parse'];
  secrets?: Partial<SecretsAdmin>;
  repo?: Partial<ProviderAuthRepository>;
  uuid?: ProviderAuthServiceDeps['uuid'];
  now?: ProviderAuthServiceDeps['now'];
}

interface Harness {
  service: ReturnType<typeof createProviderAuthService>;
  deps: ProviderAuthServiceDeps;
  rowsById: Map<string, ProviderAuthRow>;
  secretsStore: Map<string, string>;
  repoMocks: {
    list: ReturnType<typeof vi.fn>;
    listByProvider: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  secretMocks: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

function defaultParseResult(): ParseResult {
  return {
    label: 'codex:test',
    accountId: null,
    projectId: null,
    payload: { accessToken: 'plaintext-token' },
  };
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  // Minimal in-memory backing stores so the service's own state
  // transitions (insert → update during validate) read back coherently.
  const rowsById = new Map<string, ProviderAuthRow>();
  const secretsStore = new Map<string, string>();

  const repoMocks = {
    list: vi.fn(() =>
      Array.from(rowsById.values()).sort(
        (a, b) => a.importedAt - b.importedAt,
      ),
    ),
    listByProvider: vi.fn((provider: ProviderId) =>
      Array.from(rowsById.values()).filter((r) => r.provider === provider),
    ),
    get: vi.fn((id: string) => rowsById.get(id) ?? null),
    insert: vi.fn((row: ProviderAuthRow) => {
      rowsById.set(row.id, { ...row });
    }),
    update: vi.fn((id: string, patch: Partial<ProviderAuthRow>) => {
      const existing = rowsById.get(id);
      if (existing) rowsById.set(id, { ...existing, ...patch });
    }),
    remove: vi.fn((id: string) => {
      rowsById.delete(id);
    }),
  };

  const secretMocks = {
    set: vi.fn((key: string, value: string) => {
      secretsStore.set(key, value);
    }),
    get: vi.fn(
      (key: string) =>
        (secretsStore.has(key) ? secretsStore.get(key)! : null) as
          | string
          | null,
    ),
    remove: vi.fn((key: string) => {
      secretsStore.delete(key);
    }),
  };

  // Apply caller overrides on top of the in-memory defaults.
  if (overrides.repo) {
    for (const [k, v] of Object.entries(overrides.repo)) {
      (repoMocks as Record<string, unknown>)[k] = v;
    }
  }
  if (overrides.secrets) {
    for (const [k, v] of Object.entries(overrides.secrets)) {
      (secretMocks as Record<string, unknown>)[k] = v;
    }
  }

  const deps: ProviderAuthServiceDeps = {
    repo: repoMocks as unknown as ProviderAuthRepository,
    secrets: secretMocks as unknown as SecretsAdmin,
    showOpenDialog:
      overrides.showOpenDialog ??
      vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: ['/tmp/codex.json'],
      }),
    readFile:
      overrides.readFile ??
      vi.fn().mockResolvedValue('{"access_token":"plaintext-token"}'),
    statFile:
      overrides.statFile ?? vi.fn().mockResolvedValue({ size: 100 }),
    parse: overrides.parse ?? vi.fn().mockReturnValue(defaultParseResult()),
    uuid: overrides.uuid ?? vi.fn().mockReturnValue(FIXED_UUID),
    now: overrides.now ?? vi.fn().mockReturnValue(FIXED_NOW),
  };

  const service = createProviderAuthService(deps);
  return { service, deps, rowsById, secretsStore, repoMocks, secretMocks };
}

// ---------------------------------------------------------------------------
// Happy-path imports — one fixture per provider
// ---------------------------------------------------------------------------

interface HappyCase {
  provider: ProviderId;
  filePath: string;
  parsed: ParseResult;
  expectedCapability:
    | 'official'
    | 'health_only'
    | 'usage_only'
    | 'unsupported';
}

const HAPPY_CASES: ReadonlyArray<HappyCase> = [
  {
    provider: 'claude-code',
    filePath: '/tmp/claude.json',
    parsed: {
      label: 'claude:acc_xyz',
      accountId: 'acc_claude_xyz',
      projectId: null,
      payload: { accessToken: 'sk-ant-AAAA', refreshToken: 'sk-ant-BBBB' },
    },
    expectedCapability: 'official',
  },
  {
    provider: 'codex',
    filePath: '/tmp/codex.json',
    parsed: {
      label: 'codex:acc_codex',
      accountId: 'acc_codex_42',
      projectId: null,
      payload: { accessToken: 'eyJhbGciOiJ...A', refreshToken: 'rt-codex' },
    },
    expectedCapability: 'official',
  },
  {
    provider: 'gemini-cli',
    filePath: '/tmp/gemini-cli.json',
    parsed: {
      label: 'gemini-cli:proj_abc',
      accountId: null,
      projectId: 'proj_abc',
      payload: {
        accessToken: 'ya29.gemini-AAAA',
        projectId: 'proj_abc',
      },
    },
    expectedCapability: 'official',
  },
  {
    provider: 'antigravity',
    filePath: '/tmp/antigravity.json',
    parsed: {
      label: 'antigravity:proj_def',
      accountId: null,
      projectId: 'proj_def',
      payload: {
        accessToken: 'ya29.antigravity-CCCC',
        projectId: 'proj_def',
      },
    },
    expectedCapability: 'official',
  },
  {
    provider: 'gemini-api',
    filePath: '/tmp/gemini-api.json',
    parsed: {
      label: 'gemini-api:imported',
      accountId: null,
      projectId: null,
      payload: { apiKey: 'AIzaSy-API-KEY' },
    },
    expectedCapability: 'health_only',
  },
  {
    provider: 'deepseek',
    filePath: '/tmp/deepseek.json',
    parsed: {
      label: 'deepseek:imported',
      accountId: null,
      projectId: null,
      payload: { apiKey: 'sk-deepseek-DDDD' },
    },
    expectedCapability: 'health_only',
  },
  {
    provider: 'xiaomi',
    filePath: '/tmp/xiaomi.json',
    parsed: {
      label: 'xiaomi:imported',
      accountId: null,
      projectId: null,
      payload: { apiKey: 'mimo-EEEE' },
    },
    expectedCapability: 'health_only',
  },
  {
    provider: 'openai-compatible',
    filePath: '/tmp/oai-compat.json',
    parsed: {
      label: 'openai-compatible:imported',
      accountId: null,
      projectId: null,
      payload: { apiKey: 'sk-FFFF', baseUrl: 'https://api.example.com' },
    },
    expectedCapability: 'health_only',
  },
];

describe('createProviderAuthService — happy-path import', () => {
  for (const caseSpec of HAPPY_CASES) {
    it(`imports a ${caseSpec.provider} fixture and returns redacted metadata`, async () => {
      const harness = makeHarness({
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [caseSpec.filePath],
        }),
        parse: vi.fn().mockReturnValue(caseSpec.parsed),
      });

      const result = await harness.service.importFromFile({
        provider: caseSpec.provider,
      });

      // The renderer-visible projection contains no secret fields.
      expect(result).toMatchObject({
        id: FIXED_UUID,
        provider: caseSpec.provider,
        label: caseSpec.parsed.label,
        source: 'cpa-auth-file',
        accountId: caseSpec.parsed.accountId,
        projectId: caseSpec.parsed.projectId,
        quotaCapability: caseSpec.expectedCapability,
        importedAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        lastValidatedAt: FIXED_NOW,
        lastQuotaAt: null,
      });
      expect(result.lastErrorCode).toBeNull();
      expect(result.lastErrorMessage).toBeNull();
      expect(result).not.toHaveProperty('secretKey');

      const json = JSON.stringify(result);
      // The plaintext token / api key never appear in the response.
      if (caseSpec.parsed.payload.accessToken) {
        expect(json).not.toContain(caseSpec.parsed.payload.accessToken);
      }
      if (caseSpec.parsed.payload.apiKey) {
        expect(json).not.toContain(caseSpec.parsed.payload.apiKey);
      }

      // Secret was written under the expected key.
      expect(harness.secretMocks.set).toHaveBeenCalledTimes(1);
      const [setKey, setValue] = harness.secretMocks.set.mock.calls[0]!;
      expect(setKey).toBe(`cpaAuth.providerAuth.${FIXED_UUID}`);
      expect(typeof setValue).toBe('string');

      // Row was inserted exactly once.
      expect(harness.repoMocks.insert).toHaveBeenCalledTimes(1);
      const insertedRow = harness.repoMocks.insert.mock
        .calls[0]![0] as ProviderAuthRow;
      expect(insertedRow.id).toBe(FIXED_UUID);
      expect(insertedRow.secretKey).toBe(
        `cpaAuth.providerAuth.${FIXED_UUID}`,
      );
      expect(insertedRow.quotaCapability).toBe(caseSpec.expectedCapability);
    });
  }
});

// ---------------------------------------------------------------------------
// Cancellation, validation, and read-side guard rails
// ---------------------------------------------------------------------------

describe('createProviderAuthService — file selection guards', () => {
  it('returns code="cancelled" when the dialog is dismissed', async () => {
    const harness = makeHarness({
      showOpenDialog: vi
        .fn()
        .mockResolvedValue({ canceled: true, filePaths: [] }),
    });

    await expect(
      harness.service.importFromFile({ provider: 'codex' }),
    ).rejects.toMatchObject({
      name: 'ProviderAuthError',
      code: 'cancelled',
    });

    // No file was opened, no parsing occurred, and no state mutated.
    expect(harness.deps.readFile).not.toHaveBeenCalled();
    expect(harness.deps.statFile).not.toHaveBeenCalled();
    expect(harness.deps.parse).not.toHaveBeenCalled();
    expect(harness.secretMocks.set).not.toHaveBeenCalled();
    expect(harness.repoMocks.insert).not.toHaveBeenCalled();
  });

  it('returns code="parse_error" when the file is over 1 MiB', async () => {
    const harness = makeHarness({
      statFile: vi.fn().mockResolvedValue({ size: 2_000_000 }),
    });

    await expect(
      harness.service.importFromFile({ provider: 'codex' }),
    ).rejects.toMatchObject({
      name: 'ProviderAuthError',
      code: 'parse_error',
    });

    // The 1 MiB guard runs before readFile, so no bytes were read.
    expect(harness.deps.readFile).not.toHaveBeenCalled();
    expect(harness.deps.parse).not.toHaveBeenCalled();
    expect(harness.secretMocks.set).not.toHaveBeenCalled();
    expect(harness.repoMocks.insert).not.toHaveBeenCalled();
  });

  it('returns code="unsupported_file" for disallowed extensions', async () => {
    for (const filePath of ['/tmp/auth.exe', '/tmp/auth.bat']) {
      const harness = makeHarness({
        showOpenDialog: vi
          .fn()
          .mockResolvedValue({ canceled: false, filePaths: [filePath] }),
      });

      await expect(
        harness.service.importFromFile({ provider: 'codex' }),
      ).rejects.toMatchObject({
        name: 'ProviderAuthError',
        code: 'unsupported_file',
      });

      expect(harness.deps.statFile).not.toHaveBeenCalled();
      expect(harness.deps.readFile).not.toHaveBeenCalled();
      expect(harness.secretMocks.set).not.toHaveBeenCalled();
      expect(harness.repoMocks.insert).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Failure isolation between secrets / repository writes
// ---------------------------------------------------------------------------

describe('createProviderAuthService — write-path isolation', () => {
  it('propagates parser errors without writing secret or row', async () => {
    const harness = makeHarness({
      parse: vi.fn().mockImplementation(() => {
        throw new ProviderAuthError('parse_error', 'invalid JSON');
      }),
    });

    await expect(
      harness.service.importFromFile({ provider: 'codex' }),
    ).rejects.toMatchObject({
      name: 'ProviderAuthError',
      code: 'parse_error',
    });

    expect(harness.secretMocks.set).not.toHaveBeenCalled();
    expect(harness.repoMocks.insert).not.toHaveBeenCalled();
  });

  it('does not insert a row when secrets.set throws SecretsUnavailableError', async () => {
    const harness = makeHarness({
      secrets: {
        set: vi.fn(() => {
          throw new SecretsUnavailableError();
        }),
      },
    });

    await expect(
      harness.service.importFromFile({ provider: 'codex' }),
    ).rejects.toBeInstanceOf(SecretsUnavailableError);

    expect(harness.repoMocks.insert).not.toHaveBeenCalled();
  });

  it('rolls the secret back when repo.insert throws after a successful secrets.set', async () => {
    const insertError = new Error('UNIQUE constraint failed');
    const harness = makeHarness({
      repo: {
        insert: vi.fn(() => {
          throw insertError;
        }),
      },
    });

    await expect(
      harness.service.importFromFile({ provider: 'codex' }),
    ).rejects.toBe(insertError);

    expect(harness.secretMocks.set).toHaveBeenCalledTimes(1);
    expect(harness.secretMocks.remove).toHaveBeenCalledWith(
      `cpaAuth.providerAuth.${FIXED_UUID}`,
    );
    // No row remains in the in-memory store.
    expect(harness.rowsById.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Lightweight validate
// ---------------------------------------------------------------------------

describe('createProviderAuthService — lightweight validate', () => {
  it.each<['gemini-cli' | 'antigravity']>([['gemini-cli'], ['antigravity']])(
    'flags project_missing for %s payloads without projectId',
    async (provider) => {
      const harness = makeHarness({
        showOpenDialog: vi.fn().mockResolvedValue({
          canceled: false,
          filePaths: [`/tmp/${provider}.json`],
        }),
        parse: vi.fn().mockReturnValue({
          label: `${provider}:imported`,
          accountId: null,
          projectId: null,
          payload: { accessToken: 'ya29.AAAA' },
        } satisfies ParseResult),
      });

      const result = await harness.service.importFromFile({ provider });

      expect(result.lastErrorCode).toBe('project_missing');
      expect(result.lastErrorMessage).toBeTypeOf('string');
      expect((result.lastErrorMessage ?? '').length).toBeGreaterThan(0);
      expect((result.lastErrorMessage ?? '').length).toBeLessThanOrEqual(80);

      // The row was still persisted (Requirement 8.4: validation
      // failure does not abort the import).
      expect(harness.repoMocks.insert).toHaveBeenCalledTimes(1);
      const stored = harness.rowsById.get(FIXED_UUID);
      expect(stored?.lastErrorCode).toBe('project_missing');
    },
  );
});

// ---------------------------------------------------------------------------
// Idempotent remove
// ---------------------------------------------------------------------------

describe('createProviderAuthService — remove', () => {
  it('is idempotent across consecutive calls', async () => {
    const harness = makeHarness();

    // First seed a row via the happy-path import so remove has
    // something to delete.
    await harness.service.importFromFile({ provider: 'codex' });
    expect(harness.rowsById.size).toBe(1);

    // First removal clears row + secret.
    expect(() => harness.service.remove(FIXED_UUID)).not.toThrow();
    expect(harness.rowsById.size).toBe(0);
    expect(harness.secretsStore.size).toBe(0);

    // Second removal is a no-op — neither the underlying repo nor
    // the secrets store throws on a missing id / key.
    expect(() => harness.service.remove(FIXED_UUID)).not.toThrow();
    expect(harness.rowsById.size).toBe(0);
    expect(harness.secretsStore.size).toBe(0);
  });
});
