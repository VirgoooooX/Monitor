// Typed read/write helpers for every table in the application's own
// SQLite database.
//
// References:
//   - design.md §SQLite Schema, §Integrity invariants, §Data Models
//   - PLAN.md §SQLite Schema
//
// Design notes:
//   - Each repository is a "prepare-once, exec-many" object: a factory
//     prepares the parameterised statements at construction time, and
//     the returned methods are thin typed wrappers around `.run` /
//     `.get` / `.all`. This is the recommended pattern in
//     better-sqlite3 and keeps the hot path (3-second tick) under
//     ~100 µs per insert.
//   - All settings values are JSON-encoded before they hit the
//     `settings.value TEXT` column; secrets are stored as raw blobs
//     (encryption is layered on top in task 1.6, not here).
//   - `usage_events` writes use `INSERT OR IGNORE` so that re-scanning
//     append-only Codex JSONL files never produces duplicate rows
//     (design.md §Property 5, §Property 6).
//   - Integers from SQLite arrive as `number` (we never enable
//     `safeIntegers`); the boolean columns `ok` and `api_ok` are
//     stored as 0/1 and converted on the way in/out.

import type { MonitorDatabase } from './db';
import type {
  AppSettings,
  CapabilityResult,
  CollectorHealthRow,
  ProviderAuthErrorCode,
  ProviderAuthMetadata,
  ProviderId,
  QuotaCapability,
  UsageProviderSummary,
  UsageRange,
} from '../types';

// ---------------------------------------------------------------------------
// Shared row helpers
// ---------------------------------------------------------------------------

const toBoolInt = (value: boolean): 0 | 1 => (value ? 1 : 0);
const fromBoolInt = (value: number): boolean => value !== 0;

// ---------------------------------------------------------------------------
// Settings repository (key/value with JSON encoding)
// ---------------------------------------------------------------------------

interface SettingsRow {
  key: string;
  value: string;
}

export interface SettingsRepository {
  /** Get a typed JSON-decoded value, or `undefined` when the key is missing. */
  get<T>(key: string): T | undefined;
  /** JSON-encode and upsert. */
  set<T>(key: string, value: T): void;
  /** Delete a single key. No-op if it does not exist. */
  remove(key: string): void;
  /** All keys currently stored (sorted ASC). */
  keys(): string[];
  /** Convenience for the diagnostics export. */
  entries(): Array<{ key: string; value: unknown }>;
}

export function createSettingsRepository(db: MonitorDatabase): SettingsRepository {
  const selectStmt = db.prepare<[string], SettingsRow>(
    'SELECT key, value FROM settings WHERE key = ?',
  );
  const upsertStmt = db.prepare<[string, string]>(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const deleteStmt = db.prepare<[string]>('DELETE FROM settings WHERE key = ?');
  const keysStmt = db.prepare<[], { key: string }>(
    'SELECT key FROM settings ORDER BY key ASC',
  );
  const allStmt = db.prepare<[], SettingsRow>(
    'SELECT key, value FROM settings ORDER BY key ASC',
  );

  return {
    get<T>(key: string): T | undefined {
      const row = selectStmt.get(key);
      if (!row) {
        return undefined;
      }
      return JSON.parse(row.value) as T;
    },
    set<T>(key: string, value: T): void {
      upsertStmt.run(key, JSON.stringify(value));
    },
    remove(key: string): void {
      deleteStmt.run(key);
    },
    keys(): string[] {
      return keysStmt.all().map((r) => r.key);
    },
    entries(): Array<{ key: string; value: unknown }> {
      return allStmt.all().map((row) => ({
        key: row.key,
        value: JSON.parse(row.value) as unknown,
      }));
    },
  };
}

/** Reserved key for the persisted full `AppSettings` blob. */
export const APP_SETTINGS_KEY = 'app.settings';

/**
 * Convenience read/write of the canonical `AppSettings` value (which
 * lives under `APP_SETTINGS_KEY` inside `settings`). Used by the IPC
 * `getSettings` / `updateSettings` handlers wired in task 3.11.
 */
export function readAppSettings(repo: SettingsRepository): AppSettings | undefined {
  return repo.get<AppSettings>(APP_SETTINGS_KEY);
}

export function writeAppSettings(
  repo: SettingsRepository,
  settings: AppSettings,
): void {
  repo.set<AppSettings>(APP_SETTINGS_KEY, settings);
}

// ---------------------------------------------------------------------------
// Secrets repository (raw blob get/set/delete; encryption is task 1.6)
// ---------------------------------------------------------------------------

interface SecretRow {
  key: string;
  encrypted_value: Buffer;
}

export interface SecretsRepository {
  /** Read the raw ciphertext blob; `undefined` when the key is missing. */
  get(key: string): Buffer | undefined;
  /** Upsert the raw ciphertext blob. */
  set(key: string, encryptedValue: Buffer): void;
  /** Delete a single key. No-op if it does not exist. */
  remove(key: string): void;
  /** All known keys (sorted ASC). */
  keys(): string[];
}

export function createSecretsRepository(db: MonitorDatabase): SecretsRepository {
  const selectStmt = db.prepare<[string], SecretRow>(
    'SELECT key, encrypted_value FROM secrets WHERE key = ?',
  );
  const upsertStmt = db.prepare<[string, Buffer]>(
    `INSERT INTO secrets (key, encrypted_value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
  );
  const deleteStmt = db.prepare<[string]>('DELETE FROM secrets WHERE key = ?');
  const keysStmt = db.prepare<[], { key: string }>(
    'SELECT key FROM secrets ORDER BY key ASC',
  );

  return {
    get(key: string): Buffer | undefined {
      const row = selectStmt.get(key);
      return row?.encrypted_value;
    },
    set(key: string, encryptedValue: Buffer): void {
      upsertStmt.run(key, encryptedValue);
    },
    remove(key: string): void {
      deleteStmt.run(key);
    },
    keys(): string[] {
      return keysStmt.all().map((r) => r.key);
    },
  };
}

// ---------------------------------------------------------------------------
// Network samples
// ---------------------------------------------------------------------------

export type NetworkLayer =
  | 'router'
  | 'controller_tcp'
  | 'controller_api'
  | 'probe';

export interface NetworkSampleInsert {
  timestamp: number;
  layer: NetworkLayer;
  target: string;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface NetworkSampleRow {
  id: number;
  timestamp: number;
  layer: NetworkLayer;
  target: string;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

interface NetworkSampleRawRow {
  id: number;
  timestamp: number;
  layer: NetworkLayer;
  target: string;
  ok: number;
  latency_ms: number | null;
  error: string | null;
}

const mapNetworkRow = (row: NetworkSampleRawRow): NetworkSampleRow => ({
  id: row.id,
  timestamp: row.timestamp,
  layer: row.layer,
  target: row.target,
  ok: fromBoolInt(row.ok),
  latencyMs: row.latency_ms,
  error: row.error,
});

export interface NetworkSamplesRepository {
  insert(sample: NetworkSampleInsert): void;
  /** Most recent sample for the given layer, or `undefined` if none exist. */
  latestForLayer(layer: NetworkLayer): NetworkSampleRow | undefined;
  /** Most recent N samples for a layer (newest first). */
  recentForLayer(layer: NetworkLayer, limit: number): NetworkSampleRow[];
  /** Samples within `[fromTs, toTs]` for a layer (newest first). */
  forLayerInWindow(
    layer: NetworkLayer,
    fromTs: number,
    toTs: number,
  ): NetworkSampleRow[];
}

export function createNetworkSamplesRepository(
  db: MonitorDatabase,
): NetworkSamplesRepository {
  const insertStmt = db.prepare<
    [number, NetworkLayer, string, 0 | 1, number | null, string | null]
  >(
    `INSERT INTO network_samples
       (timestamp, layer, target, ok, latency_ms, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const latestStmt = db.prepare<[NetworkLayer], NetworkSampleRawRow>(
    `SELECT id, timestamp, layer, target, ok, latency_ms, error
       FROM network_samples
      WHERE layer = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT 1`,
  );
  const recentStmt = db.prepare<[NetworkLayer, number], NetworkSampleRawRow>(
    `SELECT id, timestamp, layer, target, ok, latency_ms, error
       FROM network_samples
      WHERE layer = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`,
  );
  const windowStmt = db.prepare<
    [NetworkLayer, number, number],
    NetworkSampleRawRow
  >(
    `SELECT id, timestamp, layer, target, ok, latency_ms, error
       FROM network_samples
      WHERE layer = ? AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp DESC, id DESC`,
  );

  return {
    insert(sample) {
      insertStmt.run(
        sample.timestamp,
        sample.layer,
        sample.target,
        toBoolInt(sample.ok),
        sample.latencyMs,
        sample.error,
      );
    },
    latestForLayer(layer) {
      const row = latestStmt.get(layer);
      return row ? mapNetworkRow(row) : undefined;
    },
    recentForLayer(layer, limit) {
      return recentStmt.all(layer, limit).map(mapNetworkRow);
    },
    forLayerInWindow(layer, fromTs, toTs) {
      return windowStmt.all(layer, fromTs, toTs).map(mapNetworkRow);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenClash snapshots
// ---------------------------------------------------------------------------

export type OpenClashSnapshotStatus =
  | 'ok'
  | 'auth_error'
  | 'unreachable'
  | 'http_error'
  | 'verify_mismatch'
  | 'verify_timeout';

export interface OpenClashSnapshotInsert {
  timestamp: number;
  apiOk: boolean;
  mode: string | null;
  groupName: string | null;
  nodeName: string | null;
  status: OpenClashSnapshotStatus;
}

export interface OpenClashSnapshotRow {
  id: number;
  timestamp: number;
  apiOk: boolean;
  mode: string | null;
  groupName: string | null;
  nodeName: string | null;
  status: OpenClashSnapshotStatus;
}

interface OpenClashSnapshotRawRow {
  id: number;
  timestamp: number;
  api_ok: number;
  mode: string | null;
  group_name: string | null;
  node_name: string | null;
  status: OpenClashSnapshotStatus;
}

const mapOpenClashRow = (row: OpenClashSnapshotRawRow): OpenClashSnapshotRow => ({
  id: row.id,
  timestamp: row.timestamp,
  apiOk: fromBoolInt(row.api_ok),
  mode: row.mode,
  groupName: row.group_name,
  nodeName: row.node_name,
  status: row.status,
});

export interface OpenClashSnapshotsRepository {
  insert(snapshot: OpenClashSnapshotInsert): void;
  /** Most recent snapshot regardless of status. */
  latest(): OpenClashSnapshotRow | undefined;
  /** Most recent successful (`status = 'ok'`) snapshot. */
  latestOk(): OpenClashSnapshotRow | undefined;
  /** Most recent N snapshots (newest first). */
  recent(limit: number): OpenClashSnapshotRow[];
}

export function createOpenClashSnapshotsRepository(
  db: MonitorDatabase,
): OpenClashSnapshotsRepository {
  const insertStmt = db.prepare<
    [
      number,
      0 | 1,
      string | null,
      string | null,
      string | null,
      OpenClashSnapshotStatus,
    ]
  >(
    `INSERT INTO openclash_snapshots
       (timestamp, api_ok, mode, group_name, node_name, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const latestStmt = db.prepare<[], OpenClashSnapshotRawRow>(
    `SELECT id, timestamp, api_ok, mode, group_name, node_name, status
       FROM openclash_snapshots
      ORDER BY timestamp DESC, id DESC
      LIMIT 1`,
  );
  const latestOkStmt = db.prepare<[], OpenClashSnapshotRawRow>(
    `SELECT id, timestamp, api_ok, mode, group_name, node_name, status
       FROM openclash_snapshots
      WHERE status = 'ok'
      ORDER BY timestamp DESC, id DESC
      LIMIT 1`,
  );
  const recentStmt = db.prepare<[number], OpenClashSnapshotRawRow>(
    `SELECT id, timestamp, api_ok, mode, group_name, node_name, status
       FROM openclash_snapshots
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`,
  );

  return {
    insert(snapshot) {
      insertStmt.run(
        snapshot.timestamp,
        toBoolInt(snapshot.apiOk),
        snapshot.mode,
        snapshot.groupName,
        snapshot.nodeName,
        snapshot.status,
      );
    },
    latest() {
      const row = latestStmt.get();
      return row ? mapOpenClashRow(row) : undefined;
    },
    latestOk() {
      const row = latestOkStmt.get();
      return row ? mapOpenClashRow(row) : undefined;
    },
    recent(limit) {
      return recentStmt.all(limit).map(mapOpenClashRow);
    },
  };
}

// ---------------------------------------------------------------------------
// Node samples (per-node delay history from rolling scan)
// ---------------------------------------------------------------------------

export interface NodeSampleInsert {
  timestamp: number;
  groupName: string;
  nodeName: string;
  source: string | null;
  delayMs: number | null;
  ok: boolean;
  error: string | null;
}

export interface NodeSampleRow {
  id: number;
  timestamp: number;
  groupName: string;
  nodeName: string;
  source: string | null;
  delayMs: number | null;
  ok: boolean;
  error: string | null;
}

interface NodeSampleRawRow {
  id: number;
  timestamp: number;
  group_name: string;
  node_name: string;
  source: string | null;
  delay_ms: number | null;
  ok: number;
  error: string | null;
}

const mapNodeRow = (row: NodeSampleRawRow): NodeSampleRow => ({
  id: row.id,
  timestamp: row.timestamp,
  groupName: row.group_name,
  nodeName: row.node_name,
  source: row.source,
  delayMs: row.delay_ms,
  ok: fromBoolInt(row.ok),
  error: row.error,
});

export interface NodeSamplesRepository {
  insert(sample: NodeSampleInsert): void;
  /** Most recent N samples for a specific node (newest first). */
  recentForNode(
    groupName: string,
    nodeName: string,
    limit: number,
  ): NodeSampleRow[];
  /** Most recent sample for every node in a group. */
  latestPerNodeInGroup(groupName: string): NodeSampleRow[];
}

export function createNodeSamplesRepository(
  db: MonitorDatabase,
): NodeSamplesRepository {
  const insertStmt = db.prepare<
    [
      number,
      string,
      string,
      string | null,
      number | null,
      0 | 1,
      string | null,
    ]
  >(
    `INSERT INTO node_samples
       (timestamp, group_name, node_name, source, delay_ms, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const recentForNodeStmt = db.prepare<
    [string, string, number],
    NodeSampleRawRow
  >(
    `SELECT id, timestamp, group_name, node_name, source, delay_ms, ok, error
       FROM node_samples
      WHERE group_name = ? AND node_name = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`,
  );
  // For each (group, node) pair return the row with the largest id —
  // since `id` increments monotonically per insert, MAX(id) is also
  // the latest timestamp regardless of clock skew.
  const latestPerNodeStmt = db.prepare<[string], NodeSampleRawRow>(
    `SELECT ns.id, ns.timestamp, ns.group_name, ns.node_name,
            ns.source, ns.delay_ms, ns.ok, ns.error
       FROM node_samples ns
       JOIN (
         SELECT node_name, MAX(id) AS max_id
           FROM node_samples
          WHERE group_name = ?
          GROUP BY node_name
       ) latest ON latest.max_id = ns.id
      ORDER BY ns.node_name ASC`,
  );

  return {
    insert(sample) {
      insertStmt.run(
        sample.timestamp,
        sample.groupName,
        sample.nodeName,
        sample.source,
        sample.delayMs,
        toBoolInt(sample.ok),
        sample.error,
      );
    },
    recentForNode(groupName, nodeName, limit) {
      return recentForNodeStmt
        .all(groupName, nodeName, limit)
        .map(mapNodeRow);
    },
    latestPerNodeInGroup(groupName) {
      return latestPerNodeStmt.all(groupName).map(mapNodeRow);
    },
  };
}

// ---------------------------------------------------------------------------
// Usage events (idempotent dedup via UNIQUE(provider, source_path, source_offset))
// ---------------------------------------------------------------------------

export interface UsageEventInsert {
  timestamp: number;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number | null;
  source: string;
  sourcePath: string;
  sourceOffset: number;
  eventId: string | null;
}

export interface UsageEventRow {
  id: number;
  timestamp: number;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number | null;
  source: string;
  sourcePath: string;
  sourceOffset: number;
  eventId: string | null;
}

interface UsageEventRawRow {
  id: number;
  timestamp: number;
  provider: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_usd: number | null;
  source: string;
  source_path: string;
  source_offset: number;
  event_id: string | null;
}

const mapUsageRow = (row: UsageEventRawRow): UsageEventRow => ({
  id: row.id,
  timestamp: row.timestamp,
  provider: row.provider,
  model: row.model,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheTokens: row.cache_tokens,
  costUsd: row.cost_usd,
  source: row.source,
  sourcePath: row.source_path,
  sourceOffset: row.source_offset,
  eventId: row.event_id,
});

interface ProviderAggregateRawRow {
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_usd: number | null;
  event_count: number;
}

/** Aggregate row used to compose a `UsageProviderSummary`. */
export interface ProviderUsageAggregate {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number | null;
  eventCount: number;
}

/**
 * One bucket of token usage for a single provider, sliced by
 * calendar day or hour-of-day. Powers the stacked bar chart in
 * the renderer's `UsagePanel` (see ccusage / phuryn/claude-usage
 * for prior art on per-day token visualisation).
 *
 * `bucketStartTs` is the UTC epoch-ms corresponding to the local
 * midnight (`granularity === 'day'`) or the local hour boundary
 * (`granularity === 'hour'`) the bucket represents. The
 * granularity choice lives on `UsageBucketsInput.granularity` so
 * the same query path can serve "today" (24 hourly bars) and
 * "month" (30 daily bars).
 */
export interface ProviderUsageBucket {
  /** ISO-like local label `YYYY-MM-DD` or `YYYY-MM-DD HH:00`. */
  bucketKey: string;
  /** Epoch ms at the local boundary the bucket starts on. */
  bucketStartTs: number;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number | null;
  eventCount: number;
}

export type UsageBucketGranularity = 'hour' | 'day';

export interface UsageBucketsInput extends UsageRangeBounds {
  granularity: UsageBucketGranularity;
  /**
   * Local-time offset in minutes (e.g. `-new Date().getTimezoneOffset()`)
   * the renderer wants the buckets aligned to. SQLite has no native
   * notion of "local time", so the caller passes the offset and the
   * query shifts the timestamp before applying `strftime('%Y-%m-%d',
   * ts/1000, 'unixepoch')`. Pass `0` for UTC.
   */
  tzOffsetMinutes: number;
}

export interface UsageRangeBounds {
  /** Inclusive lower bound (Unix ms). */
  fromTs: number;
  /** Inclusive upper bound (Unix ms). */
  toTs: number;
}

export interface UsageEventsRepository {
  /**
   * `INSERT OR IGNORE` — duplicate `(provider, source_path,
   * source_offset)` triples are silently dropped (design.md §Property
   * 5). Returns `true` when a new row was inserted.
   */
  insertIgnore(event: UsageEventInsert): boolean;
  /**
   * Largest `source_offset` already stored for the given (provider,
   * source_path) pair. Used as the watermark for incremental scans.
   * Returns `null` when no rows exist yet.
   */
  watermark(provider: string, sourcePath: string): number | null;
  /** Aggregate totals per provider in the closed interval. */
  aggregateByProvider(bounds: UsageRangeBounds): ProviderUsageAggregate[];
  /** Lookup the aggregate for a specific provider in the interval. */
  aggregateForProvider(
    provider: string,
    bounds: UsageRangeBounds,
  ): ProviderUsageAggregate;
  /**
   * Aggregate totals grouped by `(bucketKey, provider)` over the
   * closed interval, where `bucketKey` is the local-time YYYY-MM-DD
   * (or YYYY-MM-DD HH:00) the row falls in. Returns rows sorted by
   * `(bucketKey ASC, provider ASC)` so the renderer can iterate a
   * pre-sorted stream into a stacked bar chart without re-sorting.
   *
   * Buckets with zero events are omitted; the renderer fills the gap
   * by walking the inclusive `[fromTs, toTs]` range itself, since it
   * already knows the granularity.
   */
  bucketsByProviderAndDay(input: UsageBucketsInput): ProviderUsageBucket[];
  /** Most recent N events for a provider (newest first). */
  recentForProvider(provider: string, limit: number): UsageEventRow[];
}

export function createUsageEventsRepository(
  db: MonitorDatabase,
): UsageEventsRepository {
  const insertStmt = db.prepare<
    [
      number,
      string,
      string | null,
      number,
      number,
      number,
      number | null,
      string,
      string,
      number,
      string | null,
    ]
  >(
    `INSERT OR IGNORE INTO usage_events
       (timestamp, provider, model,
        input_tokens, output_tokens, cache_tokens,
        cost_usd, source, source_path, source_offset, event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const watermarkStmt = db.prepare<[string, string], { max_offset: number | null }>(
    `SELECT MAX(source_offset) AS max_offset
       FROM usage_events
      WHERE provider = ? AND source_path = ?`,
  );
  const aggregateAllStmt = db.prepare<
    [number, number],
    ProviderAggregateRawRow
  >(
    `SELECT provider,
            COALESCE(SUM(input_tokens), 0)  AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_tokens), 0)  AS cache_tokens,
            SUM(cost_usd)                   AS cost_usd,
            COUNT(*)                        AS event_count
       FROM usage_events
      WHERE timestamp BETWEEN ? AND ?
      GROUP BY provider
      ORDER BY provider ASC`,
  );
  const aggregateOneStmt = db.prepare<
    [string, string, number, number],
    ProviderAggregateRawRow
  >(
    `SELECT ? AS provider,
            COALESCE(SUM(input_tokens), 0)  AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_tokens), 0)  AS cache_tokens,
            SUM(cost_usd)                   AS cost_usd,
            COUNT(*)                        AS event_count
       FROM usage_events
      WHERE provider = ? AND timestamp BETWEEN ? AND ?`,
  );
  const recentStmt = db.prepare<[string, number], UsageEventRawRow>(
    `SELECT id, timestamp, provider, model,
            input_tokens, output_tokens, cache_tokens,
            cost_usd, source, source_path, source_offset, event_id
       FROM usage_events
      WHERE provider = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`,
  );

  // Stacked-bar chart aggregation. The two prepared statements
  // differ only in their `strftime` format: '%Y-%m-%d' produces
  // 24h-wide local-day buckets, '%Y-%m-%d %H:00' produces 1h-wide
  // local-hour buckets. SQLite has no notion of a local timezone so
  // the caller supplies a `tzOffsetMinutes` (e.g. UTC+8 → 480) which
  // shifts the timestamp before `strftime` slices it, then the
  // matching offset is applied again to recover the bucket's
  // local-midnight epoch-ms via `strftime('%s', ...)`.
  //
  // The shift is `(timestamp + offset_ms) / 1000`. The recover step
  // multiplies by 1000 and subtracts the offset back so renderers
  // get the original epoch-ms anchor without doing the math again.
  const bucketByDayStmt = db.prepare<
    [number, number, number, number, number],
    {
      bucket_key: string;
      bucket_start_ts: number;
      provider: string;
      input_tokens: number;
      output_tokens: number;
      cache_tokens: number;
      cost_usd: number | null;
      event_count: number;
    }
  >(
    `SELECT strftime('%Y-%m-%d', (timestamp + ?) / 1000, 'unixepoch') AS bucket_key,
            (CAST(strftime('%s',
                strftime('%Y-%m-%d', (timestamp + ?) / 1000, 'unixepoch'))
                AS INTEGER) * 1000) - ? AS bucket_start_ts,
            provider,
            COALESCE(SUM(input_tokens), 0)  AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_tokens), 0)  AS cache_tokens,
            SUM(cost_usd)                   AS cost_usd,
            COUNT(*)                        AS event_count
       FROM usage_events
      WHERE timestamp BETWEEN ? AND ?
      GROUP BY bucket_key, provider
      ORDER BY bucket_key ASC, provider ASC`,
  );
  const bucketByHourStmt = db.prepare<
    [number, number, number, number, number],
    {
      bucket_key: string;
      bucket_start_ts: number;
      provider: string;
      input_tokens: number;
      output_tokens: number;
      cache_tokens: number;
      cost_usd: number | null;
      event_count: number;
    }
  >(
    `SELECT strftime('%Y-%m-%d %H:00', (timestamp + ?) / 1000, 'unixepoch') AS bucket_key,
            (CAST(strftime('%s',
                strftime('%Y-%m-%d %H:00:00', (timestamp + ?) / 1000, 'unixepoch'))
                AS INTEGER) * 1000) - ? AS bucket_start_ts,
            provider,
            COALESCE(SUM(input_tokens), 0)  AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_tokens), 0)  AS cache_tokens,
            SUM(cost_usd)                   AS cost_usd,
            COUNT(*)                        AS event_count
       FROM usage_events
      WHERE timestamp BETWEEN ? AND ?
      GROUP BY bucket_key, provider
      ORDER BY bucket_key ASC, provider ASC`,
  );

  const mapAggregate = (
    row: ProviderAggregateRawRow,
  ): ProviderUsageAggregate => ({
    provider: row.provider,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    costUsd: row.cost_usd,
    eventCount: row.event_count,
  });

  return {
    insertIgnore(event) {
      const result = insertStmt.run(
        event.timestamp,
        event.provider,
        event.model,
        event.inputTokens,
        event.outputTokens,
        event.cacheTokens,
        event.costUsd,
        event.source,
        event.sourcePath,
        event.sourceOffset,
        event.eventId,
      );
      return result.changes > 0;
    },
    watermark(provider, sourcePath) {
      const row = watermarkStmt.get(provider, sourcePath);
      return row?.max_offset ?? null;
    },
    aggregateByProvider(bounds) {
      return aggregateAllStmt
        .all(bounds.fromTs, bounds.toTs)
        .map(mapAggregate);
    },
    aggregateForProvider(provider, bounds) {
      // The `?` for provider is bound twice: once as the literal in
      // the SELECT list and once in the WHERE clause. This guarantees
      // the returned row carries the requested provider name even
      // when there are zero events.
      const row = aggregateOneStmt.get(provider, provider, bounds.fromTs, bounds.toTs);
      if (!row) {
        return {
          provider,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          costUsd: null,
          eventCount: 0,
        };
      }
      return mapAggregate(row);
    },
    bucketsByProviderAndDay(input) {
      const offsetMs = input.tzOffsetMinutes * 60_000;
      const stmt =
        input.granularity === 'hour' ? bucketByHourStmt : bucketByDayStmt;
      // Three `?` for the offset (twice in the SELECT, once for the
      // recovery math), then the WHERE-clause bounds.
      return stmt
        .all(offsetMs, offsetMs, offsetMs, input.fromTs, input.toTs)
        .map((row) => ({
          bucketKey: row.bucket_key,
          bucketStartTs: row.bucket_start_ts,
          provider: row.provider,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheTokens: row.cache_tokens,
          costUsd: row.cost_usd,
          eventCount: row.event_count,
        }));
    },
    recentForProvider(provider, limit) {
      return recentStmt.all(provider, limit).map(mapUsageRow);
    },
  };
}

/**
 * Convenience: convert a raw aggregate plus a status/reason into the
 * UI-shaped {@link UsageProviderSummary}. Kept here so repositories
 * remain the single place that knows the column-to-camelCase mapping.
 */
export function aggregateToProviderSummary(
  aggregate: ProviderUsageAggregate,
  status: UsageProviderSummary['status'],
  reason?: string,
): UsageProviderSummary {
  const summary: UsageProviderSummary = {
    provider: aggregate.provider,
    status,
    inputTokens: aggregate.inputTokens,
    outputTokens: aggregate.outputTokens,
    cacheTokens: aggregate.cacheTokens,
    costUsd: aggregate.costUsd,
    eventCount: aggregate.eventCount,
    source: 'events',
    hasTokenBreakdown: (aggregate.inputTokens + aggregate.outputTokens + aggregate.cacheTokens) > 0,
  };
  if (reason !== undefined) {
    summary.reason = reason;
  }
  return summary;
}

/**
 * The set of usage ranges the dashboard supports. Re-exported here so
 * that callers depending on the repositories module can import the
 * type without pulling all of `types.ts`.
 */
export type { UsageRange };

// ---------------------------------------------------------------------------
// Collector health (one row per collector id; upsert)
// ---------------------------------------------------------------------------

export interface CollectorHealthUpsert {
  collector: string;
  lastRunAt: number | null;
  lastSuccessAt?: number | null;
  lastError?: string | null;
  lastErrorAt?: number | null;
  consecutiveFailures: number;
}

interface CollectorHealthRawRow {
  collector: string;
  last_run_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  consecutive_failures: number;
}

const mapCollectorHealthRow = (
  row: CollectorHealthRawRow,
): CollectorHealthRow => ({
  collector: row.collector,
  lastRunAt: row.last_run_at,
  lastSuccessAt: row.last_success_at,
  lastError: row.last_error,
  lastErrorAt: row.last_error_at,
  consecutiveFailures: row.consecutive_failures,
});

export interface CollectorHealthRepository {
  /** Upsert a complete health snapshot. Use the helpers below for the
   *  common success / failure transitions. */
  upsert(row: CollectorHealthUpsert): void;
  /**
   * Mark a successful run: stamps `last_run_at` + `last_success_at`,
   * clears `last_error` / `last_error_at`, resets
   * `consecutive_failures` to 0.
   */
  recordSuccess(collector: string, at: number): void;
  /**
   * Mark a failed run: stamps `last_run_at` + `last_error_at`, sets
   * `last_error`, increments `consecutive_failures` by 1, leaves
   * `last_success_at` untouched.
   */
  recordFailure(collector: string, at: number, error: string): void;
  /** Read a single row, or `undefined` when the collector has never run. */
  get(collector: string): CollectorHealthRow | undefined;
  /** All known collectors (sorted by id). */
  list(): CollectorHealthRow[];
}

export function createCollectorHealthRepository(
  db: MonitorDatabase,
): CollectorHealthRepository {
  const upsertStmt = db.prepare<
    [
      string,
      number | null,
      number | null,
      string | null,
      number | null,
      number,
    ]
  >(
    `INSERT INTO collector_health
       (collector, last_run_at, last_success_at, last_error,
        last_error_at, consecutive_failures)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(collector) DO UPDATE SET
       last_run_at          = excluded.last_run_at,
       last_success_at      = excluded.last_success_at,
       last_error           = excluded.last_error,
       last_error_at        = excluded.last_error_at,
       consecutive_failures = excluded.consecutive_failures`,
  );
  // On success we need to preserve the upstream `last_success_at`
  // semantics: we always overwrite it with `at`. `last_error` /
  // `last_error_at` are cleared, `consecutive_failures` reset.
  const recordSuccessStmt = db.prepare<[string, number, number]>(
    `INSERT INTO collector_health
       (collector, last_run_at, last_success_at, last_error,
        last_error_at, consecutive_failures)
     VALUES (?, ?, ?, NULL, NULL, 0)
     ON CONFLICT(collector) DO UPDATE SET
       last_run_at          = excluded.last_run_at,
       last_success_at      = excluded.last_success_at,
       last_error           = NULL,
       last_error_at        = NULL,
       consecutive_failures = 0`,
  );
  // On failure we keep the existing `last_success_at` (may be NULL),
  // bump `consecutive_failures` by 1 (or set to 1 on first insert),
  // and stamp the error fields.
  const recordFailureStmt = db.prepare<[string, number, string, number]>(
    `INSERT INTO collector_health
       (collector, last_run_at, last_success_at, last_error,
        last_error_at, consecutive_failures)
     VALUES (?, ?, NULL, ?, ?, 1)
     ON CONFLICT(collector) DO UPDATE SET
       last_run_at          = excluded.last_run_at,
       last_error           = excluded.last_error,
       last_error_at        = excluded.last_error_at,
       consecutive_failures = collector_health.consecutive_failures + 1`,
  );
  const selectStmt = db.prepare<[string], CollectorHealthRawRow>(
    `SELECT collector, last_run_at, last_success_at, last_error,
            last_error_at, consecutive_failures
       FROM collector_health
      WHERE collector = ?`,
  );
  const listStmt = db.prepare<[], CollectorHealthRawRow>(
    `SELECT collector, last_run_at, last_success_at, last_error,
            last_error_at, consecutive_failures
       FROM collector_health
      ORDER BY collector ASC`,
  );

  return {
    upsert(row) {
      upsertStmt.run(
        row.collector,
        row.lastRunAt,
        row.lastSuccessAt ?? null,
        row.lastError ?? null,
        row.lastErrorAt ?? null,
        row.consecutiveFailures,
      );
    },
    recordSuccess(collector, at) {
      recordSuccessStmt.run(collector, at, at);
    },
    recordFailure(collector, at, error) {
      recordFailureStmt.run(collector, at, error, at);
    },
    get(collector) {
      const row = selectStmt.get(collector);
      return row ? mapCollectorHealthRow(row) : undefined;
    },
    list() {
      return listStmt.all().map(mapCollectorHealthRow);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenClash config-change audit (network-quick-actions)
// ---------------------------------------------------------------------------
//
// Records start + end rows for every Config_Switch initiated through
// the Quick Actions panel. See:
//   - design.md §`openclash_config_changes` Table
//   - design.md §`openclash.config.audit.ts` — Config Switch Audit Writer
//   - requirements.md Requirement 8 (audit & observability)
//
// Invariants enforced here:
//   - `confirmed` is always stored as `1` (Requirement 6 guarantees
//     every flow that reaches the audit writer was user-confirmed).
//   - `final_path`, `result_code`, `duration_ms` are NULL on `'start'`
//     rows (the start row is written immediately after lock acquisition,
//     before any management-client call).
//   - `duration_ms` is clamped to the closed interval `[0, 3_600_000]`
//     in `insertEnd` so a runaway clock or watchdog cannot persist a
//     wildly inflated value.
//
// This repository is the only writer for the `openclash_config_changes`
// table; payload bodies and credentials are never read or written here.

/** `'start'` is logged immediately after lock acquisition; `'end'` just
 *  before lock release (Property 6 in design.md §Correctness Properties). */
export type ConfigChangeStatus = 'start' | 'end';

/**
 * Closed set of result codes that may land in `result_code` on `'end'`
 * rows. Mirrors `ManagementErrorCode | 'ok'` from
 * design.md §`openclash.management.service.ts`; `switch_in_progress` is
 * deliberately excluded because the orchestrator returns it before the
 * audit writer is invoked (no `'start'` row is ever written for it).
 */
export type ConfigChangeResultCode =
  | 'ok'
  | 'auth_error'
  | 'http_error'
  | 'network_error'
  | 'verify_timeout'
  | 'verify_mismatch'
  | 'not_supported';

/** Hard cap on persisted `duration_ms`. One hour is far longer than any
 *  legitimate switch (verify window <= 30s, request timeout <= 30s). */
export const MAX_CONFIG_CHANGE_DURATION_MS = 3_600_000;

export interface ConfigChangeStartInput {
  timestamp: number;
  /** Active config at the time of click; `null` when management couldn't read it. */
  startPath: string | null;
  targetPath: string;
  /** Always `true`; threaded through to make the invariant explicit at the call site. */
  confirmed: true;
}

export interface ConfigChangeEndInput {
  timestamp: number;
  startPath: string | null;
  targetPath: string;
  /** Active config after verify; `null` when verify never observed a path. */
  finalPath: string | null;
  resultCode: ConfigChangeResultCode;
  /** Wall-clock ms from start to end. Clamped into `[0, 3_600_000]` on insert. */
  durationMs: number;
  /** Always `true`. */
  confirmed: true;
}

export interface OpenClashConfigChangeRow {
  id: number;
  timestamp: number;
  status: ConfigChangeStatus;
  startPath: string | null;
  targetPath: string;
  /** `null` on `'start'` rows. */
  finalPath: string | null;
  /** `null` on `'start'` rows; one of {@link ConfigChangeResultCode} on `'end'`. */
  resultCode: ConfigChangeResultCode | null;
  /** `null` on `'start'` rows. */
  durationMs: number | null;
  /** Always `true` in v1; surfaced here so audit consumers do not special-case absence. */
  confirmed: boolean;
}

interface OpenClashConfigChangeRawRow {
  id: number;
  timestamp: number;
  status: ConfigChangeStatus;
  start_path: string | null;
  target_path: string;
  final_path: string | null;
  result_code: ConfigChangeResultCode | null;
  duration_ms: number | null;
  confirmed: number;
}

const mapConfigChangeRow = (
  row: OpenClashConfigChangeRawRow,
): OpenClashConfigChangeRow => ({
  id: row.id,
  timestamp: row.timestamp,
  status: row.status,
  startPath: row.start_path,
  targetPath: row.target_path,
  finalPath: row.final_path,
  resultCode: row.result_code,
  durationMs: row.duration_ms,
  confirmed: fromBoolInt(row.confirmed),
});

/**
 * Clamp a raw duration into `[0, MAX_CONFIG_CHANGE_DURATION_MS]`.
 * Non-finite or negative inputs collapse to `0` so SQLite never sees
 * a NaN or `-Infinity` value.
 */
function clampDurationMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value > MAX_CONFIG_CHANGE_DURATION_MS) {
    return MAX_CONFIG_CHANGE_DURATION_MS;
  }
  return Math.trunc(value);
}

export interface OpenClashConfigChangesRepository {
  /**
   * Insert a `'start'` row. `final_path`, `result_code`, `duration_ms`
   * are stored as NULL; `confirmed` is stored as `1`.
   * Returns the freshly assigned row id.
   */
  insertStart(input: ConfigChangeStartInput): number;
  /**
   * Insert an `'end'` row. `duration_ms` is clamped to
   * `[0, 3_600_000]` (see {@link MAX_CONFIG_CHANGE_DURATION_MS}).
   */
  insertEnd(input: ConfigChangeEndInput): void;
  /** Most recent N rows (newest first). */
  recent(limit: number): OpenClashConfigChangeRow[];
  /** Most recent row regardless of status, or `undefined` when the table is empty. */
  latest(): OpenClashConfigChangeRow | undefined;
}

export function createOpenClashConfigChangesRepository(
  db: MonitorDatabase,
): OpenClashConfigChangesRepository {
  // `'start'` rows always carry NULL for the trailing three columns;
  // separating the two prepared statements keeps the contract visible
  // at the SQL level instead of relying on caller discipline.
  const insertStartStmt = db.prepare<
    [number, string | null, string, 0 | 1]
  >(
    `INSERT INTO openclash_config_changes
       (timestamp, status, start_path, target_path,
        final_path, result_code, duration_ms, confirmed)
     VALUES (?, 'start', ?, ?, NULL, NULL, NULL, ?)`,
  );
  const insertEndStmt = db.prepare<
    [
      number,
      string | null,
      string,
      string | null,
      ConfigChangeResultCode,
      number,
      0 | 1,
    ]
  >(
    `INSERT INTO openclash_config_changes
       (timestamp, status, start_path, target_path,
        final_path, result_code, duration_ms, confirmed)
     VALUES (?, 'end', ?, ?, ?, ?, ?, ?)`,
  );
  const recentStmt = db.prepare<[number], OpenClashConfigChangeRawRow>(
    `SELECT id, timestamp, status, start_path, target_path,
            final_path, result_code, duration_ms, confirmed
       FROM openclash_config_changes
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`,
  );
  const latestStmt = db.prepare<[], OpenClashConfigChangeRawRow>(
    `SELECT id, timestamp, status, start_path, target_path,
            final_path, result_code, duration_ms, confirmed
       FROM openclash_config_changes
      ORDER BY timestamp DESC, id DESC
      LIMIT 1`,
  );

  return {
    insertStart(input) {
      // Requirement 6 invariant: `confirmed` is always 1.
      const result = insertStartStmt.run(
        input.timestamp,
        input.startPath,
        input.targetPath,
        toBoolInt(input.confirmed),
      );
      // `lastInsertRowid` is `number | bigint`; we never enable
      // `safeIntegers`, so it is always `number` in practice.
      return Number(result.lastInsertRowid);
    },
    insertEnd(input) {
      insertEndStmt.run(
        input.timestamp,
        input.startPath,
        input.targetPath,
        input.finalPath,
        input.resultCode,
        clampDurationMs(input.durationMs),
        toBoolInt(input.confirmed),
      );
    },
    recent(limit) {
      return recentStmt.all(limit).map(mapConfigChangeRow);
    },
    latest() {
      const row = latestStmt.get();
      return row ? mapConfigChangeRow(row) : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Provider auth (cpa-quota-import)
// ---------------------------------------------------------------------------
//
// Stores per-account, non-secret metadata for CPA / CLIProxyAPI auth
// files imported through `desktop:importProviderAuthFile`. The
// matching encrypted Secret_Payload lives in the `secrets` table
// under key `cpaAuth.providerAuth.<id>`; this repository never
// touches it.
//
// References:
//   - cpa-quota-import/design.md §`provider_auth` (new table)
//   - cpa-quota-import/design.md §`ProviderAuthRepository`
//   - cpa-quota-import/requirements.md Requirement 3.1, 3.2
//   - cpa-quota-import/requirements.md Requirement 9.1, 9.2
//
// Invariants enforced here:
//   - `list()` orders by `imported_at ASC` so the renderer's account
//     list is stable across reloads (Requirement 9.1).
//   - `secret_key` is UNIQUE at the SQL layer (see migration #3); the
//     repository surfaces that constraint to callers as the native
//     better-sqlite3 `SqliteError` so the service layer can map it to
//     a redacted error code.
//   - Neither `insert` nor `remove` opens its own transaction. The
//     `Provider_Auth_Service` wraps a `secrets.set` + `repo.insert`
//     pair (or `repo.remove` + `secrets.remove`) inside a single
//     `db.transaction(...)` to guarantee no orphan rows survive a
//     crash mid-flight (Requirement 3.4, 3.5).
//   - Every column maps 1:1 to a `ProviderAuthRow` field; nothing
//     decrypts the secret payload on this hot path. The renderer-
//     facing redaction (`ProviderAuthMetadata`) is produced by
//     `Provider_Auth_Service.redactRow()`, not here.

/**
 * Internal row shape returned by {@link ProviderAuthRepository}. Adds
 * the `secretKey` column on top of the renderer-visible
 * `ProviderAuthMetadata`. `secretKey` MUST NOT cross the IPC boundary
 * — it identifies the row in the `secrets` table only.
 */
export interface ProviderAuthRow extends ProviderAuthMetadata {
  /**
   * Pointer into the `secrets` table for this account's encrypted
   * Secret_Payload. Always `cpaAuth.providerAuth.<id>` in v1; UNIQUE
   * at the SQL layer so a row maps to exactly one secret blob.
   */
  secretKey: string;
}

/**
 * Subset of fields {@link ProviderAuthRepository.update} accepts.
 * Pinned by `cpa-quota-import/design.md §ProviderAuthRepository` —
 * `id`, `provider`, `source`, `secretKey`, and `importedAt` are
 * immutable for the lifetime of the row (re-imports go through the
 * delete + insert path, not through `update`).
 */
export type ProviderAuthUpdatePatch = Partial<
  Pick<
    ProviderAuthRow,
    | 'label'
    | 'accountId'
    | 'projectId'
    | 'quotaCapability'
    | 'updatedAt'
    | 'lastValidatedAt'
    | 'lastQuotaAt'
    | 'lastErrorCode'
    | 'lastErrorMessage'
    | 'enabled'
  >
>;

export interface ProviderAuthRepository {
  /** All rows, ordered by `imported_at ASC`. Stable for the UI list. */
  list(): ProviderAuthRow[];
  /** Rows for a single provider, ordered by `imported_at ASC`. */
  listByProvider(provider: ProviderId): ProviderAuthRow[];
  /** Single row by id, or `null` when missing. */
  get(id: string): ProviderAuthRow | null;
  /**
   * Insert a brand-new row. Throws on `secret_key` UNIQUE collision
   * or duplicate `id`. Does NOT open its own transaction — call
   * inside `db.transaction(...)` so the matching `secrets.set`
   * either both commits or both rolls back.
   */
  insert(row: ProviderAuthRow): void;
  /**
   * Patch a subset of mutable columns on an existing row. Unspecified
   * keys are left untouched. No-op when the id does not exist
   * (mirrors the idempotent `remove` contract; the service layer
   * checks existence via `get` before calling `update`).
   */
  update(id: string, patch: ProviderAuthUpdatePatch): void;
  /**
   * Delete a row by id. Idempotent — deleting a missing id is a
   * no-op. Does NOT open its own transaction; the service layer
   * pairs this with `secrets.remove` inside a single
   * `db.transaction(...)`.
   */
  remove(id: string): void;
}

interface ProviderAuthRawRow {
  id: string;
  provider: string;
  label: string;
  source: string;
  account_id: string | null;
  project_id: string | null;
  quota_capability: string;
  imported_at: number;
  updated_at: number;
  last_validated_at: number | null;
  last_quota_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  secret_key: string;
  enabled: number;
}

const mapProviderAuthRow = (row: ProviderAuthRawRow): ProviderAuthRow => ({
  id: row.id,
  // The closed `ProviderId` / `QuotaCapability` / `ProviderAuthErrorCode`
  // unions are validated upstream by the zod schemas before any row
  // ever reaches `insert`; the SQL layer stores them as TEXT and we
  // trust that contract on the way out. Casting here keeps the row
  // mapper allocation-free (no per-column validation on the hot
  // `getQuotaStatus` path).
  provider: row.provider as ProviderId,
  label: row.label,
  source: row.source as ProviderAuthMetadata['source'],
  accountId: row.account_id,
  projectId: row.project_id,
  quotaCapability: row.quota_capability as QuotaCapability,
  importedAt: row.imported_at,
  updatedAt: row.updated_at,
  lastValidatedAt: row.last_validated_at,
  lastQuotaAt: row.last_quota_at,
  lastErrorCode:
    row.last_error_code === null
      ? null
      : (row.last_error_code as ProviderAuthErrorCode),
  lastErrorMessage: row.last_error_message,
  // SQLite has no native boolean; the column is stored as INTEGER
  // 0/1 with default 1 so legacy rows from pre-v4 schemas surface
  // as `enabled: true` after the migration backfills the column.
  enabled: row.enabled !== 0,
  secretKey: row.secret_key,
});

export function createProviderAuthRepository(
  db: MonitorDatabase,
): ProviderAuthRepository {
  // Cached prepared statements — same "prepare-once, exec-many"
  // pattern the surrounding repositories use.
  const listStmt = db.prepare<[], ProviderAuthRawRow>(
    `SELECT id, provider, label, source, account_id, project_id,
            quota_capability, imported_at, updated_at,
            last_validated_at, last_quota_at,
            last_error_code, last_error_message, secret_key, enabled
       FROM provider_auth
      ORDER BY imported_at ASC, id ASC`,
  );
  const listByProviderStmt = db.prepare<[ProviderId], ProviderAuthRawRow>(
    `SELECT id, provider, label, source, account_id, project_id,
            quota_capability, imported_at, updated_at,
            last_validated_at, last_quota_at,
            last_error_code, last_error_message, secret_key, enabled
       FROM provider_auth
      WHERE provider = ?
      ORDER BY imported_at ASC, id ASC`,
  );
  const getStmt = db.prepare<[string], ProviderAuthRawRow>(
    `SELECT id, provider, label, source, account_id, project_id,
            quota_capability, imported_at, updated_at,
            last_validated_at, last_quota_at,
            last_error_code, last_error_message, secret_key, enabled
       FROM provider_auth
      WHERE id = ?`,
  );
  const insertStmt = db.prepare<
    [
      string,
      ProviderId,
      string,
      ProviderAuthMetadata['source'],
      string | null,
      string | null,
      QuotaCapability,
      number,
      number,
      number | null,
      number | null,
      ProviderAuthErrorCode | null,
      string | null,
      string,
      number,
    ]
  >(
    `INSERT INTO provider_auth
       (id, provider, label, source, account_id, project_id,
        quota_capability, imported_at, updated_at,
        last_validated_at, last_quota_at,
        last_error_code, last_error_message, secret_key, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const removeStmt = db.prepare<[string]>(
    'DELETE FROM provider_auth WHERE id = ?',
  );

  // `update` accepts a sparse patch, so each mutable column gets its
  // own statement that uses `COALESCE(?, existing)` semantics: the
  // service layer either passes the new value or `undefined`. We
  // build the SET clause dynamically per call from the keys present
  // in the patch — this stays parameterised (no SQL injection) and
  // keeps unspecified columns untouched. The set of allowed columns
  // is enumerated explicitly to keep the surface tight.
  const COLUMN_BY_KEY: Record<keyof ProviderAuthUpdatePatch, string> = {
    label: 'label',
    accountId: 'account_id',
    projectId: 'project_id',
    quotaCapability: 'quota_capability',
    updatedAt: 'updated_at',
    lastValidatedAt: 'last_validated_at',
    lastQuotaAt: 'last_quota_at',
    lastErrorCode: 'last_error_code',
    lastErrorMessage: 'last_error_message',
    enabled: 'enabled',
  };

  return {
    list() {
      return listStmt.all().map(mapProviderAuthRow);
    },
    listByProvider(provider) {
      return listByProviderStmt.all(provider).map(mapProviderAuthRow);
    },
    get(id) {
      const row = getStmt.get(id);
      return row ? mapProviderAuthRow(row) : null;
    },
    insert(row) {
      insertStmt.run(
        row.id,
        row.provider,
        row.label,
        row.source,
        row.accountId,
        row.projectId,
        row.quotaCapability,
        row.importedAt,
        row.updatedAt,
        row.lastValidatedAt,
        row.lastQuotaAt,
        row.lastErrorCode,
        row.lastErrorMessage,
        row.secretKey,
        row.enabled ? 1 : 0,
      );
    },
    update(id, patch) {
      // Filter to keys that are explicitly present (including
      // `null`); `undefined` values are skipped so callers can pass a
      // single `Partial` without spelling out which columns to leave
      // alone. An empty patch is a silent no-op — the SQL layer
      // would refuse `UPDATE ... SET WHERE` anyway.
      const entries = (
        Object.keys(patch) as Array<keyof ProviderAuthUpdatePatch>
      ).filter((key) => patch[key] !== undefined);
      if (entries.length === 0) {
        return;
      }
      const assignments = entries
        .map((key) => `${COLUMN_BY_KEY[key]} = ?`)
        .join(', ');
      const values = entries.map((key) => {
        const v = patch[key];
        // `enabled` is the only boolean column; the SQLite layer
        // stores INTEGER 0/1 to keep the column comparable with the
        // `DEFAULT 1` migration backfill.
        if (key === 'enabled') return (v as boolean) ? 1 : 0;
        return v as string | number | null;
      });
      // Prepared statements are cached internally by better-sqlite3,
      // so the per-call `prepare` cost is negligible; the only thing
      // that varies is which columns are present in `assignments`.
      const stmt = db.prepare<Array<string | number | null>>(
        `UPDATE provider_auth SET ${assignments} WHERE id = ?`,
      );
      stmt.run(...values, id);
    },
    remove(id) {
      // `DELETE` is idempotent at the SQL layer — affecting zero rows
      // is not an error, which matches the Requirement 9.2 contract
      // ("delete is idempotent").
      removeStmt.run(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Composite — convenience bundle for app.ts and IPC handlers
// ---------------------------------------------------------------------------

export interface Repositories {
  settings: SettingsRepository;
  secrets: SecretsRepository;
  networkSamples: NetworkSamplesRepository;
  openClashSnapshots: OpenClashSnapshotsRepository;
  nodeSamples: NodeSamplesRepository;
  usageEvents: UsageEventsRepository;
  collectorHealth: CollectorHealthRepository;
  openClashConfigChanges: OpenClashConfigChangesRepository;
  providerAuth: ProviderAuthRepository;
}

/**
 * Build all repositories against a shared `Database` instance. Call
 * once at boot (after migrations) and pass the returned bundle to the
 * scheduler / collectors / IPC layer.
 */
export function createRepositories(db: MonitorDatabase): Repositories {
  return {
    settings: createSettingsRepository(db),
    secrets: createSecretsRepository(db),
    networkSamples: createNetworkSamplesRepository(db),
    openClashSnapshots: createOpenClashSnapshotsRepository(db),
    nodeSamples: createNodeSamplesRepository(db),
    usageEvents: createUsageEventsRepository(db),
    collectorHealth: createCollectorHealthRepository(db),
    openClashConfigChanges: createOpenClashConfigChangesRepository(db),
    providerAuth: createProviderAuthRepository(db),
  };
}

// `CapabilityResult` is referenced in design.md; re-export here so
// downstream task 7.1 can keep its imports anchored at the store layer
// without needing a separate re-export module.
export type { CapabilityResult };
