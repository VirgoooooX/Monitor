// SQLite database factory and external-DB helpers.
//
// References:
//   - design.md §SQLite Schema, §Integrity invariants
//   - PLAN.md §SQLite Schema
//
// Design notes:
//   - `openDatabase(path?)` is the single entry point used by both the
//     production `app.ts` boot sequence and unit tests. Tests pass a
//     temp file (or `:memory:`); only the production callsite leaves
//     `path` undefined, which then resolves to
//     `app.getPath('userData')/monitor.sqlite` via `getDefaultDbPath`.
//   - We never `import { app } from 'electron'` at module load time;
//     instead `getDefaultDbPath` performs a lazy `require('electron')`
//     inside the function body. This keeps `vitest`/`tsc --noEmit`
//     happy without an Electron context (design.md §Testing Strategy).
//   - Every connection sets `journal_mode = WAL` and `foreign_keys =
//     ON`. The OWN database is read-write WAL; external SQLite files
//     consumed by collectors (e.g. Codex `logs_2.sqlite`) are opened
//     via `openExternalReadonly` which never writes and never creates
//     a -wal/-shm file, satisfying §Property 16.

import path from 'node:path';

import type { Database as BetterSqliteDatabase, Options } from 'better-sqlite3';
// CommonJS default export — `better-sqlite3` exports the constructor itself.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Database = require('better-sqlite3');

/** Filename used inside `userData` for the application's own DB. */
export const DEFAULT_DB_FILENAME = 'monitor.sqlite';

/**
 * Typed alias for the better-sqlite3 `Database` instance. Repositories
 * and migrations accept this opaque handle so callers (production and
 * tests alike) do not need to import `better-sqlite3` directly.
 */
export type MonitorDatabase = BetterSqliteDatabase;

/**
 * Thrown when {@link openExternalReadonly} is asked to open a database
 * file that does not exist. Surfaces a stable `code` so collectors can
 * decide whether to mark themselves `unavailable` vs. crash.
 */
export class ExternalDatabaseUnavailableError extends Error {
  public readonly code = 'external_db_unavailable' as const;
  public override readonly cause?: unknown;

  public constructor(
    public readonly filePath: string,
    cause?: unknown,
  ) {
    super(`External SQLite database not found or unreadable: ${filePath}`);
    this.name = 'ExternalDatabaseUnavailableError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Resolve the production database path: `<userData>/monitor.sqlite`.
 *
 * The `electron` module is `require`d lazily so this file remains
 * importable from non-Electron contexts (Vitest, plain Node scripts).
 * Throwing here when Electron is unavailable is intentional: callers
 * that genuinely need the production path *must* be running inside
 * Electron's main process.
 */
export function getDefaultDbPath(): string {
  // Lazy require — keep `electron` out of the static module graph.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const electron = require('electron') as typeof import('electron');
  const userData = electron.app.getPath('userData');
  return path.join(userData, DEFAULT_DB_FILENAME);
}

/**
 * Apply the connection-level PRAGMAs that every read-write open of
 * the application's own database must enforce.
 */
function applyOwnDbPragmas(db: MonitorDatabase): void {
  // WAL is the durable choice for a single-writer many-reader local
  // app: writers don't block readers and crash recovery rolls back to
  // the last committed transaction (design.md §Performance).
  //
  // For in-memory databases SQLite refuses WAL; we fall back silently
  // because tests opt into `:memory:` to keep the suite fast.
  if (!db.memory) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
}

/**
 * Open (and create if missing) the application's own SQLite database.
 *
 * @param filePath  Absolute path to the database file. Pass `undefined`
 *                  to use the production location returned by
 *                  {@link getDefaultDbPath}. Tests typically pass a
 *                  temp path or `':memory:'`.
 * @param options   Optional overrides forwarded to `better-sqlite3`.
 *                  `readonly` and `fileMustExist` are intentionally not
 *                  exposed here — use {@link openExternalReadonly} for
 *                  read-only access to foreign databases.
 *
 * The returned `Database` has `journal_mode = WAL` (unless the path is
 * `:memory:`) and `foreign_keys = ON`. Migrations are NOT executed by
 * this factory; callers run {@link runMigrations} from
 * `./migrations.ts` immediately after opening.
 */
export function openDatabase(
  filePath?: string,
  options?: Omit<Options, 'readonly' | 'fileMustExist'>,
): MonitorDatabase {
  const target = filePath ?? getDefaultDbPath();
  const db = new Database(target, options);
  applyOwnDbPragmas(db);
  return db;
}

/**
 * Open an *external* SQLite database in strict read-only mode.
 *
 * Used by usage collectors (e.g. Codex `logs_2.sqlite`) that observe
 * databases owned by other processes. This MUST NOT create a file or
 * a -wal/-shm pair, otherwise it could disrupt the producing process.
 *
 * @throws {ExternalDatabaseUnavailableError} if the file does not
 *         exist or cannot be opened.
 */
export function openExternalReadonly(filePath: string): MonitorDatabase {
  try {
    return new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (cause) {
    throw new ExternalDatabaseUnavailableError(filePath, cause);
  }
}
