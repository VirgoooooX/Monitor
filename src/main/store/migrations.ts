// Schema migrations for the application's own SQLite database.
//
// References:
//   - design.md §SQLite Schema, §Integrity invariants
//   - PLAN.md §SQLite Schema
//
// Design notes:
//   - Migrations are idempotent: every `CREATE` uses `IF NOT EXISTS`
//     and the migration runner consults `PRAGMA user_version` so
//     repeated calls on a fresh-or-existing DB all converge to the
//     same schema state.
//   - `PRAGMA user_version` is the canonical version pin; we do NOT
//     introduce a `_meta` table when SQLite already gives us one.
//   - Each migration runs inside a transaction so a partial schema is
//     never committed.
//   - Adding a future migration: append a new `Migration` to the
//     `MIGRATIONS` array; never edit historical entries (that breaks
//     idempotency on existing installs).

import type { MonitorDatabase } from './db';

/** Bump when adding a new migration. Equals `MIGRATIONS.length`. */
export const CURRENT_SCHEMA_VERSION = 3;

interface Migration {
  /** 1-based version this migration *upgrades to*. */
  readonly version: number;
  readonly description: string;
  readonly up: (db: MonitorDatabase) => void;
}

/**
 * Migration #1 — initial schema (design.md §SQLite Schema).
 *
 * All tables, indexes, and the `UNIQUE(provider, source_path,
 * source_offset)` constraint required for usage-event dedup.
 */
const initialSchema: Migration = {
  version: 1,
  description: 'Initial schema: settings, secrets, samples, usage_events, collector_health',
  up(db) {
    db.exec(`
      -- Key/value settings (JSON-encoded values; see SettingsRepository).
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Encrypted secrets (safeStorage ciphertext blobs only).
      CREATE TABLE IF NOT EXISTS secrets (
        key             TEXT PRIMARY KEY,
        encrypted_value BLOB NOT NULL
      );

      -- Network probe samples: router TCP, controller TCP/API, probe URLs.
      CREATE TABLE IF NOT EXISTS network_samples (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  INTEGER NOT NULL,
        layer      TEXT    NOT NULL,
        target     TEXT    NOT NULL,
        ok         INTEGER NOT NULL,
        latency_ms INTEGER NULL,
        error      TEXT    NULL
      );
      CREATE INDEX IF NOT EXISTS idx_network_layer_ts
        ON network_samples(layer, timestamp DESC);

      -- OpenClash controller snapshots (current node, switch outcomes).
      CREATE TABLE IF NOT EXISTS openclash_snapshots (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  INTEGER NOT NULL,
        api_ok     INTEGER NOT NULL,
        mode       TEXT    NULL,
        group_name TEXT    NULL,
        node_name  TEXT    NULL,
        status     TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_openclash_ts
        ON openclash_snapshots(timestamp DESC);

      -- Per-node delay samples from the rolling node-table scan.
      CREATE TABLE IF NOT EXISTS node_samples (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  INTEGER NOT NULL,
        group_name TEXT    NOT NULL,
        node_name  TEXT    NOT NULL,
        source     TEXT    NULL,
        delay_ms   INTEGER NULL,
        ok         INTEGER NOT NULL,
        error      TEXT    NULL
      );
      CREATE INDEX IF NOT EXISTS idx_node_ts
        ON node_samples(group_name, node_name, timestamp DESC);

      -- AI usage token events (idempotent dedup via UNIQUE index below).
      CREATE TABLE IF NOT EXISTS usage_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     INTEGER NOT NULL,
        provider      TEXT    NOT NULL,
        model         TEXT    NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL    NULL,
        source        TEXT    NOT NULL,
        source_path   TEXT    NOT NULL,
        source_offset INTEGER NOT NULL,
        event_id      TEXT    NULL,
        UNIQUE (provider, source_path, source_offset)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_provider_ts
        ON usage_events(provider, timestamp DESC);

      -- Per-collector health row (one row per collector id).
      CREATE TABLE IF NOT EXISTS collector_health (
        collector            TEXT PRIMARY KEY,
        last_run_at          INTEGER NULL,
        last_success_at      INTEGER NULL,
        last_error           TEXT    NULL,
        last_error_at        INTEGER NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};

/**
 * Migration #2 — `openclash_config_changes` audit table.
 *
 * Records start + end rows for every Config_Switch initiated through
 * the Network Quick Actions panel. Bodies, headers, and credentials
 * are never written here; see design.md §`openclash_config_changes`
 * Table for the column contract.
 *
 * `confirmed` is always `1`; it is stored explicitly so that audit
 * consumers do not have to special-case its absence.
 */
const openclashConfigChangesSchema: Migration = {
  version: 2,
  description: 'Add openclash_config_changes audit table for config switches',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS openclash_config_changes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   INTEGER NOT NULL,
        status      TEXT    NOT NULL,
        start_path  TEXT    NULL,
        target_path TEXT    NOT NULL,
        final_path  TEXT    NULL,
        result_code TEXT    NULL,
        duration_ms INTEGER NULL,
        confirmed   INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_openclash_config_changes_ts
        ON openclash_config_changes(timestamp DESC);
    `);
  },
};

/**
 * Migration #3 — `provider_auth` table for CPA auth import.
 *
 * Stores per-account, non-secret metadata for credentials imported
 * from CPA / CLIProxyAPI. The matching encrypted payload lives in the
 * `secrets` table under key `cpaAuth.providerAuth.<id>`; see
 * `cpa-quota-import/design.md §Storage Layout` and §`provider_auth`
 * table for the full contract.
 *
 * Column notes:
 * - `id` is a UUIDv4 generated by the import service; tracked as a
 *   `TEXT PRIMARY KEY` so renderer-visible IDs stay stable across
 *   restarts.
 * - `provider` is constrained to the `ProviderId` enum at the
 *   application layer (zod + TypeScript); SQLite holds the raw
 *   string.
 * - `quota_capability` is one of `official | health_only |
 *   usage_only | unsupported`.
 * - `last_error_message` is bounded to ≤80 chars by the writer; the
 *   column itself does not enforce a length so legacy rows remain
 *   readable.
 * - `secret_key` is `UNIQUE` so a given account always points at
 *   exactly one encrypted blob (Q4 in design.md §Open Questions
 *   Resolved).
 *
 * Two indexes mirror the dominant query shapes:
 * - `idx_provider_auth_provider` for `listByProvider(provider)` —
 *   the per-provider account list shown in the Settings UI.
 * - `idx_provider_auth_imported` for the default `ORDER BY
 *   imported_at ASC` ordering used by `list()`.
 *
 * The migration is idempotent: every `CREATE` uses `IF NOT EXISTS`,
 * and the migration runner only invokes `up` when `user_version <
 * version`, so re-running on an already-migrated DB is a no-op.
 */
const providerAuthSchema: Migration = {
  version: 3,
  description: 'Add provider_auth table for CPA auth import metadata',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_auth (
        id                  TEXT    PRIMARY KEY,
        provider            TEXT    NOT NULL,
        label               TEXT    NOT NULL,
        source              TEXT    NOT NULL,
        account_id          TEXT    NULL,
        project_id          TEXT    NULL,
        quota_capability    TEXT    NOT NULL,
        imported_at         INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        last_validated_at   INTEGER NULL,
        last_quota_at       INTEGER NULL,
        last_error_code     TEXT    NULL,
        last_error_message  TEXT    NULL,
        secret_key          TEXT    NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_provider_auth_provider
        ON provider_auth(provider);
      CREATE INDEX IF NOT EXISTS idx_provider_auth_imported
        ON provider_auth(imported_at);
    `);
  },
};

/**
 * Ordered list of migrations. Append new entries; never mutate the
 * existing ones — historical installs replay this list from their
 * current `user_version` to the latest.
 */
const MIGRATIONS: readonly Migration[] = [
  initialSchema,
  openclashConfigChangesSchema,
  providerAuthSchema,
];

/**
 * Read `PRAGMA user_version`. Returns `0` for a freshly opened DB.
 */
function readSchemaVersion(db: MonitorDatabase): number {
  const result = db.pragma('user_version', { simple: true });
  return typeof result === 'number' ? result : Number(result ?? 0);
}

/**
 * Apply every pending migration in order. Idempotent: calling on an
 * already-current DB performs no work.
 *
 * Each migration runs inside an exclusive transaction; if it throws,
 * the schema and the `user_version` pragma are both rolled back.
 */
export function runMigrations(db: MonitorDatabase): void {
  const startVersion = readSchemaVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= startVersion) {
      continue;
    }
    const apply = db.transaction(() => {
      migration.up(db);
      // `user_version` does not accept parameter binding via
      // statements; concatenating an integer literal is safe because
      // `migration.version` is a static constant defined in this file.
      db.pragma(`user_version = ${migration.version}`);
    });
    apply.exclusive();
  }
}

/**
 * Convenience for tests: open a connection and run all migrations.
 * Production code uses {@link openDatabase} + {@link runMigrations}
 * separately so the boot sequence can interleave other work.
 */
export function getCurrentSchemaVersion(db: MonitorDatabase): number {
  return readSchemaVersion(db);
}
