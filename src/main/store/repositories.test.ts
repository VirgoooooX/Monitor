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
