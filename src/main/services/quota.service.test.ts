// Feature: cpa-quota-import, Task 6.3
//
// Unit tests for `createQuotaService` (Task 6.2). Exercises the
// per-account dispatch / Promise.allSettled / stale-retention /
// 5-minute throttle / Codex local-log fallback / cache-eviction
// pathways using in-memory test doubles.
//
// References:
//   - cpa-quota-import/requirements.md Requirement 11.1, 11.2, 11.3,
//     11.5, 11.6
//   - cpa-quota-import/design.md §Quota service refactor,
//     §Foundation Phase placeholder adapters,
//     §Codex local-log fallback path

import { describe, expect, it, vi } from 'vitest';

import {
  createQuotaService,
  type QuotaServiceDeps,
} from './quota.service';
import type {
  ProviderAdapter,
  ProviderAdapterRefreshInput,
} from './quota/adapters';
import type {
  ProviderAuthRepository,
  ProviderAuthRow,
  ProviderAuthUpdatePatch,
  SettingsRepository,
} from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';
import type {
  ProviderId,
  QuotaCapability,
  QuotaSnapshot,
  QuotaWindow,
} from '../types';

// ---------------------------------------------------------------------------
// In-memory test doubles
// ---------------------------------------------------------------------------

const FIXED_NOW = 1_700_000_000_000;

function makeRow(
  provider: ProviderId,
  overrides: Partial<ProviderAuthRow> = {},
): ProviderAuthRow {
  const id = overrides.id ?? `id-${provider}`;
  return {
    id,
    provider,
    label: `${provider}:test`,
    source: 'cpa-auth-file',
    accountId: null,
    projectId: null,
    quotaCapability: 'official',
    importedAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    lastValidatedAt: null,
    lastQuotaAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    secretKey: `cpaAuth.providerAuth.${id}`,
    ...overrides,
  };
}

interface MemRepo extends ProviderAuthRepository {
  /** Direct backing map — exposed so tests can mutate state without
   *  going through repository methods (e.g. simulating an external
   *  delete between two refresh calls). */
  _rows: Map<string, ProviderAuthRow>;
}

function makeRepo(rows: ProviderAuthRow[] = []): MemRepo {
  const rowsById = new Map<string, ProviderAuthRow>(
    rows.map((r) => [r.id, { ...r }]),
  );
  return {
    _rows: rowsById,
    list: () =>
      Array.from(rowsById.values()).sort(
        (a, b) => a.importedAt - b.importedAt,
      ),
    listByProvider: (provider) =>
      Array.from(rowsById.values()).filter((r) => r.provider === provider),
    get: (id) => rowsById.get(id) ?? null,
    insert: (row) => {
      rowsById.set(row.id, { ...row });
    },
    update: (id, patch: ProviderAuthUpdatePatch) => {
      const existing = rowsById.get(id);
      if (existing) rowsById.set(id, { ...existing, ...patch });
    },
    remove: (id) => {
      rowsById.delete(id);
    },
  };
}

function makeSettings(): SettingsRepository {
  const map = new Map<string, string>();
  return {
    get<T>(key: string): T | undefined {
      const raw = map.get(key);
      if (raw === undefined) return undefined;
      return JSON.parse(raw) as T;
    },
    set<T>(key: string, value: T): void {
      map.set(key, JSON.stringify(value));
    },
    remove(key: string): void {
      map.delete(key);
    },
    keys(): string[] {
      return Array.from(map.keys()).sort();
    },
    entries() {
      return Array.from(map.entries()).map(([key, raw]) => ({
        key,
        value: JSON.parse(raw) as unknown,
      }));
    },
  };
}

function makeSecrets(): SecretsAdmin {
  const store = new Map<string, string>();
  return {
    set(key, plaintext) {
      store.set(key, plaintext);
    },
    get(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    remove(key) {
      store.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter stubs
// ---------------------------------------------------------------------------

type StubBehavior = 'success' | 'reject' | 'unsupported';

interface StubAdapterOptions {
  windows?: QuotaWindow[];
  rejectError?: Error;
}

/**
 * Build a `ProviderAdapter` whose `refresh` is a `vi.fn` so tests can
 * assert call counts and override behaviour mid-test (via
 * `mockImplementationOnce`).
 *
 *   - `success`     → returns `status: 'ok'` + the supplied windows.
 *   - `unsupported` → returns the Foundation-Phase placeholder shape.
 *   - `reject`      → throws `options.rejectError ?? Error('boom')`.
 */
function stubAdapter(
  provider: ProviderId,
  capability: 'official' | 'health_only',
  behavior: StubBehavior,
  options: StubAdapterOptions = {},
): ProviderAdapter & { refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(
    async (input: ProviderAdapterRefreshInput): Promise<QuotaSnapshot> => {
      if (behavior === 'reject') {
        throw options.rejectError ?? new Error('boom');
      }
      const status = behavior === 'success' ? 'ok' : 'unsupported';
      return {
        provider,
        capturedAt: input.now,
        source: capability === 'official' ? 'imported_auth' : 'health_check',
        windows: options.windows ?? [],
        providerAuthId: input.account.id,
        accountLabel: input.account.label,
        accountId: input.account.accountId,
        projectId: input.account.projectId,
        kind: capability === 'official' ? 'quota' : 'health',
        status,
        rawPlanLabel: null,
        modelGroup: null,
        lastErrorCode: status === 'ok' ? null : 'unsupported',
        lastErrorMessage:
          status === 'ok' ? null : 'adapter not implemented in v1',
      };
    },
  );
  return { provider, capability: capability as QuotaCapability, refresh };
}

/**
 * Build an exhaustive `Record<ProviderId, ProviderAdapter>` so the
 * service can be constructed against the closed `ProviderId` union.
 * Defaults every provider to an `unsupported` placeholder; callers
 * pass `overrides` for the providers they want to behave differently.
 */
function buildAdapters(
  overrides: Partial<Record<ProviderId, ProviderAdapter>> = {},
): Record<ProviderId, ProviderAdapter> {
  return {
    'claude-code': stubAdapter('claude-code', 'official', 'unsupported'),
    codex: stubAdapter('codex', 'official', 'unsupported'),
    'gemini-cli': stubAdapter('gemini-cli', 'official', 'unsupported'),
    antigravity: stubAdapter('antigravity', 'official', 'unsupported'),
    'gemini-api': stubAdapter('gemini-api', 'health_only', 'unsupported'),
    deepseek: stubAdapter('deepseek', 'health_only', 'unsupported'),
    xiaomi: stubAdapter('xiaomi', 'health_only', 'unsupported'),
    'openai-compatible': stubAdapter(
      'openai-compatible',
      'health_only',
      'unsupported',
    ),
    ...overrides,
  };
}

interface HarnessOverrides {
  rows?: ProviderAuthRow[];
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  parseCodexLocalRateLimits?: QuotaServiceDeps['parseCodexLocalRateLimits'];
  /** Initial value of the mock clock; defaults to {@link FIXED_NOW}. */
  startNow?: number;
}

interface Harness {
  service: ReturnType<typeof createQuotaService>;
  repo: MemRepo;
  settings: SettingsRepository;
  secrets: SecretsAdmin;
  adapters: Record<ProviderId, ProviderAdapter>;
  /** Mutable mock clock — tests advance it between refresh calls. */
  clock: { value: number };
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const repo = makeRepo(overrides.rows);
  const settings = makeSettings();
  const secrets = makeSecrets();
  const adapters = buildAdapters(overrides.adapters);
  const clock = { value: overrides.startNow ?? FIXED_NOW };
  const service = createQuotaService({
    settings,
    providerAuth: repo,
    secrets,
    adapters,
    parseCodexLocalRateLimits: overrides.parseCodexLocalRateLimits,
    now: () => clock.value,
  });
  return { service, repo, settings, secrets, adapters, clock };
}

// ---------------------------------------------------------------------------
// Test 1 — All-`unsupported` placeholders
// ---------------------------------------------------------------------------

describe('createQuotaService — all-unsupported placeholders', () => {
  it('produces a status="unsupported" snapshot for every imported account', async () => {
    const rows = [
      makeRow('claude-code', { id: 'id-A', importedAt: 1 }),
      makeRow('codex', { id: 'id-B', importedAt: 2 }),
      makeRow('gemini-api', {
        id: 'id-C',
        importedAt: 3,
        quotaCapability: 'health_only',
      }),
    ];
    const harness = makeHarness({ rows });

    const result = await harness.service.refresh();

    expect(result.snapshots).toHaveLength(3);
    const byId = new Map(
      result.snapshots.map((s) => [s.providerAuthId, s] as const),
    );
    for (const row of rows) {
      const snap = byId.get(row.id);
      expect(snap).toBeDefined();
      expect(snap!.status).toBe('unsupported');
      expect(snap!.lastErrorCode).toBe('unsupported');
      expect(snap!.provider).toBe(row.provider);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Single-account rejection does not poison the batch
// ---------------------------------------------------------------------------

describe('createQuotaService — Promise.allSettled isolation', () => {
  it('keeps successful accounts intact when one adapter rejects', async () => {
    const rows = [
      makeRow('claude-code', { id: 'id-A', importedAt: 1 }),
      makeRow('codex', { id: 'id-B', importedAt: 2 }),
      makeRow('gemini-cli', { id: 'id-C', importedAt: 3 }),
    ];
    const failingAdapter = stubAdapter('codex', 'official', 'reject', {
      rejectError: new Error('boom'),
    });
    const harness = makeHarness({
      rows,
      adapters: { codex: failingAdapter },
    });

    const result = await harness.service.refresh();

    expect(result.snapshots).toHaveLength(3);
    const byId = new Map(
      result.snapshots.map((s) => [s.providerAuthId, s] as const),
    );

    // The two surviving accounts still produced placeholder snapshots.
    expect(byId.get('id-A')?.status).toBe('unsupported');
    expect(byId.get('id-C')?.status).toBe('unsupported');

    // The failing account is marked `stale` (no previous snapshot to
    // retain — the synthesized fresh stale entry per quota.service.ts).
    const failed = byId.get('id-B');
    expect(failed?.status).toBe('stale');
    expect(failed?.lastErrorCode).toBe('network_error');
    expect(failed?.lastErrorMessage).toBe('boom');

    // The repository row for the failing account picked up the error
    // metadata so the next boot hydrates it as `stale`.
    const persistedRow = harness.repo.get('id-B');
    expect(persistedRow?.lastErrorCode).toBe('network_error');
    expect(persistedRow?.lastErrorMessage).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Stale retention across success → failure
// ---------------------------------------------------------------------------

describe('createQuotaService — stale retention', () => {
  it('keeps the previous windows after a failed refresh, marking status="stale"', async () => {
    const row = makeRow('claude-code', { id: 'id-A' });
    const fixedWindows: QuotaWindow[] = [
      { name: '5h', percentLeft: 42, resetAt: 9_999_999, windowSeconds: 18000 },
    ];
    const adapter = stubAdapter('claude-code', 'official', 'success', {
      windows: fixedWindows,
    });
    const harness = makeHarness({
      rows: [row],
      adapters: { 'claude-code': adapter },
    });

    // Refresh #1 — success. Snapshot is `ok` with the fixed windows.
    harness.clock.value = FIXED_NOW;
    const first = await harness.service.refresh();
    expect(first.snapshots).toHaveLength(1);
    expect(first.snapshots[0]!.status).toBe('ok');
    expect(first.snapshots[0]!.windows).toEqual(fixedWindows);

    // Swap the adapter to a rejecting implementation for the next call.
    adapter.refresh.mockImplementationOnce(async () => {
      throw new Error('upstream blew up');
    });

    // Advance past the 5-minute throttle so refresh #2 actually
    // dispatches to the adapter.
    harness.clock.value = FIXED_NOW + 5 * 60_000 + 1;
    const second = await harness.service.refresh();

    expect(second.snapshots).toHaveLength(1);
    const snap = second.snapshots[0]!;
    expect(snap.status).toBe('stale');
    // Previous windows survive — the renderer still has last-known-good values.
    expect(snap.windows).toEqual(fixedWindows);
    expect(snap.lastErrorCode).toBe('network_error');
    expect(snap.lastErrorMessage).toBe('upstream blew up');

    // Adapter was invoked exactly twice (refresh #1 + refresh #2).
    expect(adapter.refresh).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Per-account 5-minute throttle
// ---------------------------------------------------------------------------

describe('createQuotaService — per-account throttle', () => {
  it('issues exactly one adapter call when two refreshes are <5 minutes apart', async () => {
    const row = makeRow('claude-code', { id: 'id-A' });
    const adapter = stubAdapter('claude-code', 'official', 'unsupported');
    const harness = makeHarness({
      rows: [row],
      adapters: { 'claude-code': adapter },
    });

    // First refresh after a 1-minute clock advance — adapter runs.
    harness.clock.value = FIXED_NOW + 60_000;
    await harness.service.refresh();

    // Second refresh another 1 minute later — still inside the
    // 5-minute throttle window, so the adapter is skipped.
    harness.clock.value = FIXED_NOW + 120_000;
    await harness.service.refresh();

    expect(adapter.refresh).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Codex local-log fallback
// ---------------------------------------------------------------------------

describe('createQuotaService — Codex local-log fallback', () => {
  it('produces a __codex_local__ snapshot when no codex provider_auth row exists', async () => {
    const localSnapshot: QuotaSnapshot = {
      provider: 'codex',
      capturedAt: FIXED_NOW,
      source: 'local_log',
      windows: [
        { name: '5h', percentLeft: 17, resetAt: null, windowSeconds: 18000 },
      ],
      providerAuthId: null,
      accountLabel: null,
      accountId: null,
      projectId: null,
      kind: 'quota',
      status: 'ok',
      rawPlanLabel: null,
      modelGroup: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    const parseCodexLocalRateLimits = vi
      .fn()
      .mockResolvedValue(localSnapshot);
    const harness = makeHarness({
      rows: [],
      parseCodexLocalRateLimits,
    });

    const result = await harness.service.refresh();

    expect(parseCodexLocalRateLimits).toHaveBeenCalledTimes(1);
    expect(result.snapshots).toHaveLength(1);
    const snap = result.snapshots[0]!;
    expect(snap.providerAuthId).toBeNull();
    expect(snap.source).toBe('local_log');
    expect(snap.provider).toBe('codex');
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Deletion drops the cache entry
// ---------------------------------------------------------------------------

describe('createQuotaService — cache eviction on deletion', () => {
  it('removes the cache entry of an account that is no longer in provider_auth', async () => {
    const rows = [
      makeRow('claude-code', { id: 'id-A', importedAt: 1 }),
      makeRow('codex', { id: 'id-B', importedAt: 2 }),
    ];
    const harness = makeHarness({ rows });

    // First refresh: both accounts populate the cache.
    const first = await harness.service.refresh();
    expect(first.snapshots).toHaveLength(2);
    expect(
      first.snapshots.map((s) => s.providerAuthId).sort(),
    ).toEqual(['id-A', 'id-B']);

    // Simulate an external delete (e.g. via Provider_Auth_Service.remove).
    harness.repo.remove('id-B');

    // Second refresh on the same clock value — id-A is still
    // throttled (no adapter call) but the deleted entry is evicted
    // by the full-scope reconciliation step in refresh().
    const second = await harness.service.refresh();
    expect(second.snapshots).toHaveLength(1);
    expect(second.snapshots[0]!.providerAuthId).toBe('id-A');
  });
});
