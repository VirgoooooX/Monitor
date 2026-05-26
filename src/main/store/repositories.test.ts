// Repository unit tests for the network-quick-actions audit table.
//
// References:
//   - design.md §`openclash_config_changes` Table
//   - design.md §`openclash.config.audit.ts` — Config Switch Audit Writer
//   - requirements.md Requirement 8.1, 8.2 (audit completeness)
//
// Covers (task 2.4):
//   - Round-trip insertStart / insertEnd / latest / recent for
//     `OpenClashConfigChangesRepository`.
//   - `insertStart` returns a row id and yields `status='start'` plus
//     NULL `final_path` / `result_code` / `duration_ms`.
//   - `insertEnd` writes a `status='end'` row and `latest()` reflects it.
//   - `recent(limit)` returns newest first and is capped to `limit`.
//   - `duration_ms` is clamped to 3_600_000 inside `insertEnd`.
//   - Retention contract on `openclash_config_changes`:
//       rows with `timestamp < cutoff` are removed, newer rows are
//       preserved. Tested directly against the timestamp-based DELETE
//       so the table's retention semantics are pinned regardless of
//       whether `retentionCleanup` has been wired up yet.
//
// NOTE: These tests require `better-sqlite3` compiled against the
// running Node.js version. When the native module is compiled for
// Electron (NODE_MODULE_VERSION mismatch), the suite is skipped — same
// pattern used by `retention.test.ts`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

let Database: typeof import('better-sqlite3');
let canRun = true;

try {
  Database = (await import('better-sqlite3')).default;
  // Quick check: actually open an in-memory DB to confirm module is usable.
  const probe = new Database(':memory:');
  probe.close();
} catch {
  canRun = false;
}

const { runMigrations } = await import('./migrations');
const {
  createOpenClashConfigChangesRepository,
  MAX_CONFIG_CHANGE_DURATION_MS,
} = await import('./repositories');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openInMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('OpenClashConfigChangesRepository', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = openInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('insertStart returns a row id and writes a start row with NULL trailers', () => {
    const repo = createOpenClashConfigChangesRepository(db);

    const id = repo.insertStart({
      timestamp: 1_700_000_000_000,
      startPath: '/etc/openclash/config/main.yaml',
      targetPath: '/etc/openclash/config/backup.yaml',
      confirmed: true,
    });

    expect(id).toBeGreaterThan(0);

    const latest = repo.latest();
    expect(latest).toBeDefined();
    expect(latest!.id).toBe(id);
    expect(latest!.status).toBe('start');
    expect(latest!.startPath).toBe('/etc/openclash/config/main.yaml');
    expect(latest!.targetPath).toBe('/etc/openclash/config/backup.yaml');
    expect(latest!.finalPath).toBeNull();
    expect(latest!.resultCode).toBeNull();
    expect(latest!.durationMs).toBeNull();
    expect(latest!.confirmed).toBe(true);
    expect(latest!.timestamp).toBe(1_700_000_000_000);
  });

  it('insertEnd writes an end row that latest() reflects', () => {
    const repo = createOpenClashConfigChangesRepository(db);

    const startId = repo.insertStart({
      timestamp: 1_700_000_000_000,
      startPath: '/etc/openclash/config/main.yaml',
      targetPath: '/etc/openclash/config/backup.yaml',
      confirmed: true,
    });

    repo.insertEnd({
      timestamp: 1_700_000_005_000,
      startPath: '/etc/openclash/config/main.yaml',
      targetPath: '/etc/openclash/config/backup.yaml',
      finalPath: '/etc/openclash/config/backup.yaml',
      resultCode: 'ok',
      durationMs: 5_000,
      confirmed: true,
    });

    const latest = repo.latest();
    expect(latest).toBeDefined();
    expect(latest!.id).toBeGreaterThan(startId);
    expect(latest!.status).toBe('end');
    expect(latest!.startPath).toBe('/etc/openclash/config/main.yaml');
    expect(latest!.targetPath).toBe('/etc/openclash/config/backup.yaml');
    expect(latest!.finalPath).toBe('/etc/openclash/config/backup.yaml');
    expect(latest!.resultCode).toBe('ok');
    expect(latest!.durationMs).toBe(5_000);
    expect(latest!.confirmed).toBe(true);
    expect(latest!.timestamp).toBe(1_700_000_005_000);
  });

  it('round-trips a full start→end pair via recent()', () => {
    const repo = createOpenClashConfigChangesRepository(db);

    repo.insertStart({
      timestamp: 1_700_000_000_000,
      startPath: '/etc/openclash/config/main.yaml',
      targetPath: '/etc/openclash/config/backup.yaml',
      confirmed: true,
    });
    repo.insertEnd({
      timestamp: 1_700_000_004_000,
      startPath: '/etc/openclash/config/main.yaml',
      targetPath: '/etc/openclash/config/backup.yaml',
      finalPath: '/etc/openclash/config/backup.yaml',
      resultCode: 'ok',
      durationMs: 4_000,
      confirmed: true,
    });

    const rows = repo.recent(10);
    expect(rows.length).toBe(2);
    // Newest first.
    expect(rows[0]!.status).toBe('end');
    expect(rows[1]!.status).toBe('start');
  });

  it('recent() returns newest first and respects the limit', () => {
    const repo = createOpenClashConfigChangesRepository(db);

    const baseTs = 1_700_000_000_000;
    for (let i = 0; i < 5; i += 1) {
      repo.insertStart({
        timestamp: baseTs + i * 1000,
        startPath: null,
        targetPath: `/etc/openclash/config/profile${i}.yaml`,
        confirmed: true,
      });
    }

    const rows = repo.recent(3);
    expect(rows.length).toBe(3);
    // Strictly descending timestamps.
    expect(rows[0]!.timestamp).toBe(baseTs + 4_000);
    expect(rows[1]!.timestamp).toBe(baseTs + 3_000);
    expect(rows[2]!.timestamp).toBe(baseTs + 2_000);
  });

  it('insertEnd clamps duration_ms to MAX_CONFIG_CHANGE_DURATION_MS (3_600_000)', () => {
    const repo = createOpenClashConfigChangesRepository(db);

    repo.insertEnd({
      timestamp: 1_700_000_000_000,
      startPath: null,
      targetPath: '/etc/openclash/config/backup.yaml',
      finalPath: null,
      resultCode: 'verify_timeout',
      // Way over the cap — simulates a runaway clock or stuck watchdog.
      durationMs: 10 * 60 * 60 * 1000,
      confirmed: true,
    });

    const latest = repo.latest();
    expect(latest).toBeDefined();
    expect(latest!.durationMs).toBe(MAX_CONFIG_CHANGE_DURATION_MS);
    expect(MAX_CONFIG_CHANGE_DURATION_MS).toBe(3_600_000);
  });

  it('insertEnd clamps negative or non-finite durations to 0', () => {
    const repo = createOpenClashConfigChangesRepository(db);

    repo.insertEnd({
      timestamp: 1_700_000_000_000,
      startPath: null,
      targetPath: '/etc/openclash/config/backup.yaml',
      finalPath: null,
      resultCode: 'http_error',
      durationMs: -42,
      confirmed: true,
    });

    expect(repo.latest()!.durationMs).toBe(0);
  });

  it('latest() is undefined on an empty table', () => {
    const repo = createOpenClashConfigChangesRepository(db);
    expect(repo.latest()).toBeUndefined();
    expect(repo.recent(10)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Retention contract for openclash_config_changes
//
// Task 2.3 wires this table into `retentionCleanup`. To keep this test
// independent of that wiring landing first, we exercise the SQL contract
// directly: rows with `timestamp < cutoff` are removed and newer rows
// are preserved. Once 2.3 lands, `retentionCleanup` will issue exactly
// this DELETE alongside the other sample tables.
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('openclash_config_changes retention contract', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = openInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('deletes rows older than cutoff and preserves newer rows', () => {
    const repo = createOpenClashConfigChangesRepository(db);
    const now = Date.now();
    const cutoff = now - 30 * DAY_MS;

    const oldTs = now - 31 * DAY_MS;
    const recentTs = now - 1 * DAY_MS;

    repo.insertStart({
      timestamp: oldTs,
      startPath: null,
      targetPath: '/etc/openclash/config/old.yaml',
      confirmed: true,
    });
    repo.insertEnd({
      timestamp: oldTs + 1_000,
      startPath: null,
      targetPath: '/etc/openclash/config/old.yaml',
      finalPath: '/etc/openclash/config/old.yaml',
      resultCode: 'ok',
      durationMs: 1_000,
      confirmed: true,
    });
    repo.insertStart({
      timestamp: recentTs,
      startPath: null,
      targetPath: '/etc/openclash/config/recent.yaml',
      confirmed: true,
    });

    // Mirror the DELETE that retentionCleanup will issue (task 2.3).
    const result = db
      .prepare('DELETE FROM openclash_config_changes WHERE timestamp < ?')
      .run(cutoff);

    expect(result.changes).toBe(2);

    const surviving = repo.recent(10);
    expect(surviving.length).toBe(1);
    expect(surviving[0]!.timestamp).toBe(recentTs);
    expect(surviving[0]!.targetPath).toBe('/etc/openclash/config/recent.yaml');
  });

  it('preserves rows whose timestamp equals the cutoff (strict <)', () => {
    const repo = createOpenClashConfigChangesRepository(db);
    const now = Date.now();
    const cutoff = now - 30 * DAY_MS;

    repo.insertStart({
      timestamp: cutoff,
      startPath: null,
      targetPath: '/etc/openclash/config/edge.yaml',
      confirmed: true,
    });

    const result = db
      .prepare('DELETE FROM openclash_config_changes WHERE timestamp < ?')
      .run(cutoff);

    expect(result.changes).toBe(0);
    expect(repo.recent(10).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provider Auth repository (cpa-quota-import task 2.4)
// ---------------------------------------------------------------------------
//
// References:
//   - cpa-quota-import/design.md §`provider_auth` (new table)
//   - cpa-quota-import/design.md §`ProviderAuthRepository`
//   - cpa-quota-import/requirements.md Requirements 3.1, 3.2, 9.2
//
// Covers (task 2.4):
//   - Round-trip insert / get / list / update / remove against an
//     in-memory DB with the migration applied.
//   - `list()` orders by `imported_at ASC` (with `id ASC` as the
//     tiebreaker), and `listByProvider` filters to one provider while
//     preserving the same ordering.
//   - `secret_key` UNIQUE constraint: a second insert with the same
//     `secretKey` throws (better-sqlite3 surfaces it as `SqliteError`
//     with `code === 'SQLITE_CONSTRAINT_UNIQUE'`).
//   - `update` only mutates the columns listed in the patch — others
//     (especially the immutable `provider`, `source`, `importedAt`,
//     `secretKey` columns and the `_at` columns not in the patch)
//     remain unchanged.
//   - `remove` is idempotent: removing a non-existent id does not
//     throw and does not affect surviving rows.

const { createProviderAuthRepository: createProviderAuthRepo } = await import(
  './repositories'
);
type ProviderAuthRowT = import('./repositories').ProviderAuthRow;

function makeRow(overrides: Partial<ProviderAuthRowT> = {}): ProviderAuthRowT {
  const id = overrides.id ?? '11111111-1111-4111-8111-111111111111';
  return {
    id,
    provider: 'codex',
    label: 'codex:test',
    source: 'cpa-auth-file',
    accountId: 'acct-1',
    projectId: null,
    quotaCapability: 'official',
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastValidatedAt: null,
    lastQuotaAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    secretKey: `cpaAuth.providerAuth.${id}`,
    ...overrides,
  };
}

describe.skipIf(!canRun)('ProviderAuthRepository', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = openInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips insert / get with all _at columns and last_error_* preserved', () => {
    const repo = createProviderAuthRepo(db);

    const row = makeRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider: 'gemini-cli',
      label: 'gemini-cli:project-x',
      accountId: 'user@example.com',
      projectId: 'project-x',
      quotaCapability: 'official',
      importedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      lastValidatedAt: 1_700_000_002_000,
      lastQuotaAt: 1_700_000_003_000,
      lastErrorCode: 'project_missing',
      lastErrorMessage: 'project_id absent from CPA payload',
    });

    repo.insert(row);

    const fetched = repo.get(row.id);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(row);
  });

  it('get returns null for an unknown id', () => {
    const repo = createProviderAuthRepo(db);
    expect(repo.get('not-a-real-id')).toBeNull();
  });

  it('list returns rows ordered by imported_at ASC', () => {
    const repo = createProviderAuthRepo(db);

    // Insert in non-ascending order to prove the ORDER BY is what
    // produces the asc result, not insertion order.
    const middle = makeRow({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      provider: 'codex',
      label: 'codex:b',
      importedAt: 1_700_000_002_000,
      secretKey: 'cpaAuth.providerAuth.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    const oldest = makeRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider: 'codex',
      label: 'codex:a',
      importedAt: 1_700_000_001_000,
      secretKey: 'cpaAuth.providerAuth.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const newest = makeRow({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      provider: 'codex',
      label: 'codex:c',
      importedAt: 1_700_000_003_000,
      secretKey: 'cpaAuth.providerAuth.cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });

    repo.insert(middle);
    repo.insert(oldest);
    repo.insert(newest);

    const rows = repo.list();
    expect(rows.map((r) => r.id)).toEqual([oldest.id, middle.id, newest.id]);
    expect(rows.map((r) => r.importedAt)).toEqual([
      1_700_000_001_000,
      1_700_000_002_000,
      1_700_000_003_000,
    ]);
  });

  it('listByProvider filters to a single provider and preserves imported_at ordering', () => {
    const repo = createProviderAuthRepo(db);

    repo.insert(
      makeRow({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        provider: 'codex',
        label: 'codex:1',
        importedAt: 1_700_000_001_000,
        secretKey: 'cpaAuth.providerAuth.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    );
    repo.insert(
      makeRow({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        provider: 'gemini-cli',
        label: 'gemini-cli:1',
        importedAt: 1_700_000_002_000,
        secretKey: 'cpaAuth.providerAuth.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    );
    repo.insert(
      makeRow({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        provider: 'codex',
        label: 'codex:2',
        importedAt: 1_700_000_003_000,
        secretKey: 'cpaAuth.providerAuth.cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    );

    const codexRows = repo.listByProvider('codex');
    expect(codexRows.map((r) => r.id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
    expect(codexRows.every((r) => r.provider === 'codex')).toBe(true);

    const geminiRows = repo.listByProvider('gemini-cli');
    expect(geminiRows.map((r) => r.id)).toEqual([
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);

    // A provider with zero rows produces an empty array (not undefined).
    expect(repo.listByProvider('antigravity')).toEqual([]);
  });

  it('update mutates only the columns in the patch and leaves others untouched', () => {
    const repo = createProviderAuthRepo(db);

    const original = makeRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider: 'codex',
      label: 'codex:original',
      accountId: 'acct-original',
      projectId: null,
      quotaCapability: 'official',
      importedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastValidatedAt: null,
      lastQuotaAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      secretKey: 'cpaAuth.providerAuth.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    repo.insert(original);

    repo.update(original.id, {
      label: 'codex:renamed',
      lastQuotaAt: 1_700_000_500_000,
      updatedAt: 1_700_000_500_000,
    });

    const fetched = repo.get(original.id);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual({
      ...original,
      label: 'codex:renamed',
      updatedAt: 1_700_000_500_000,
      lastQuotaAt: 1_700_000_500_000,
    });

    // Patches that explicitly set null should write null (not skip).
    repo.update(original.id, {
      lastErrorCode: 'auth_expired',
      lastErrorMessage: 'token expired',
    });
    const afterError = repo.get(original.id);
    expect(afterError?.lastErrorCode).toBe('auth_expired');
    expect(afterError?.lastErrorMessage).toBe('token expired');

    repo.update(original.id, {
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    const cleared = repo.get(original.id);
    expect(cleared?.lastErrorCode).toBeNull();
    expect(cleared?.lastErrorMessage).toBeNull();
    // Immutable columns and other state unaffected by the clear.
    expect(cleared?.provider).toBe('codex');
    expect(cleared?.source).toBe('cpa-auth-file');
    expect(cleared?.importedAt).toBe(1_700_000_000_000);
    expect(cleared?.secretKey).toBe(
      'cpaAuth.providerAuth.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(cleared?.lastQuotaAt).toBe(1_700_000_500_000);
  });

  it('update with an empty patch is a silent no-op', () => {
    const repo = createProviderAuthRepo(db);
    const row = makeRow();
    repo.insert(row);

    expect(() => repo.update(row.id, {})).not.toThrow();
    expect(repo.get(row.id)).toEqual(row);
  });

  it('secret_key UNIQUE constraint rejects duplicate values', () => {
    const repo = createProviderAuthRepo(db);

    const first = makeRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      secretKey: 'cpaAuth.providerAuth.shared',
    });
    const second = makeRow({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      secretKey: 'cpaAuth.providerAuth.shared',
    });

    repo.insert(first);

    // better-sqlite3 throws SqliteError with this exact code on UNIQUE
    // violations; we assert on the code rather than the message text
    // (which embeds the column name and is less stable).
    expect(() => repo.insert(second)).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    );

    // The first row survives the failed second insert.
    expect(repo.list().map((r) => r.id)).toEqual([first.id]);
  });

  it('remove of a non-existent id is idempotent (no throw, no side effects)', () => {
    const repo = createProviderAuthRepo(db);

    const row = makeRow();
    repo.insert(row);

    expect(() => repo.remove('does-not-exist')).not.toThrow();
    // Calling twice is also safe.
    expect(() => repo.remove('does-not-exist')).not.toThrow();

    // The real row is untouched.
    expect(repo.get(row.id)).toEqual(row);

    // Removing the real row drops it; removing it again is still
    // idempotent.
    repo.remove(row.id);
    expect(repo.get(row.id)).toBeNull();
    expect(() => repo.remove(row.id)).not.toThrow();
    expect(repo.list()).toEqual([]);
  });
});
