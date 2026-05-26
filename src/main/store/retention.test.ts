// Retention task unit tests.
//
// Covers:
//   - Old data (> 30 days) is deleted
//   - Recent data is preserved
//   - Task does not throw on empty database
//
// NOTE: These tests require `better-sqlite3` compiled against the
// running Node.js version. When the native module is compiled for
// Electron (NODE_MODULE_VERSION mismatch), these tests are skipped.

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

// Dynamically import only when module is usable
const { runMigrations } = await import('./migrations');
const { createRetentionTask, RETENTION_TASK_ID } = await import('./retention');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openInMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)('retention task', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = openInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it('has the expected task id', () => {
    const task = createRetentionTask(db, { intervalMs: 60_000 });
    expect(task.id).toBe(RETENTION_TASK_ID);
  });

  it('deletes network_samples older than 30 days', async () => {
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const recent = now - 1 * DAY_MS;

    // Insert old and recent samples
    const insert = db.prepare(
      'INSERT INTO network_samples (timestamp, layer, reachable, latency_ms) VALUES (?, ?, ?, ?)',
    );
    insert.run(old, 'router', 1, 10);
    insert.run(recent, 'router', 1, 5);

    const task = createRetentionTask(db, { intervalMs: 60_000 });
    await task.fn();

    const rows = db
      .prepare('SELECT * FROM network_samples')
      .all() as Array<{ timestamp: number }>;

    expect(rows.length).toBe(1);
    expect(rows[0]!.timestamp).toBe(recent);
  });

  it('deletes usage_events older than 30 days', async () => {
    const now = Date.now();
    const old = now - 31 * DAY_MS;
    const recent = now - 1 * DAY_MS;

    const insert = db.prepare(
      `INSERT INTO usage_events (timestamp, provider, model, input_tokens, output_tokens, cache_tokens, cost_usd, source, source_path, source_offset, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(old, 'codex', 'gpt-4', 100, 50, 0, null, 'jsonl', '/a.jsonl', 0, 'e1');
    insert.run(recent, 'codex', 'gpt-4', 200, 100, 0, null, 'jsonl', '/b.jsonl', 0, 'e2');

    const task = createRetentionTask(db, { intervalMs: 60_000 });
    await task.fn();

    const rows = db
      .prepare('SELECT * FROM usage_events')
      .all() as Array<{ timestamp: number }>;

    expect(rows.length).toBe(1);
    expect(rows[0]!.timestamp).toBe(recent);
  });

  it('does not throw on empty tables', async () => {
    const task = createRetentionTask(db, { intervalMs: 60_000 });
    await expect(task.fn()).resolves.toBeUndefined();
  });

  it('preserves data within 30-day window', async () => {
    const now = Date.now();
    const within = now - 15 * DAY_MS;

    const insert = db.prepare(
      'INSERT INTO network_samples (timestamp, layer, reachable, latency_ms) VALUES (?, ?, ?, ?)',
    );
    insert.run(within, 'openclash_tcp', 1, 20);

    const task = createRetentionTask(db, { intervalMs: 60_000 });
    await task.fn();

    const rows = db.prepare('SELECT * FROM network_samples').all();
    expect(rows.length).toBe(1);
  });
});
