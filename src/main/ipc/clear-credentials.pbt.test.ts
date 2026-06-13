// Feature: network-quick-actions, Property 10: Clearing management credentials erases storage and invalidates the session.
//
// Validates Requirements 12.2, 12.5.
//
// Property: For every pair of arbitrary `username` / `password`
// strings, after:
//
//   1. `secrets.set('openclash.management.username', username)` and
//      `secrets.set('openclash.management.password', password)`.
//   2. A first `client.readActiveConfigPath()` priming the in-memory
//      LuCI session cookie. The fake fetch must have seen exactly
//      one login (`POST /cgi-bin/luci`) and at least one OpenClash
//      config read.
//   3. Performing the orchestration steps the
//      `clearManagementCredentials` IPC handler runs:
//        - `removeSecret('openclash.management.username')`
//        - `removeSecret('openclash.management.password')`
//        - `client.invalidateSession()`
//        - `collectorHealth.recordFailure(
//            'openclash.management', now(), 'credentials_cleared')`.
//
// the following invariants hold:
//
//   A) `secrets.get('openclash.management.username') === null`
//   B) `secrets.get('openclash.management.password') === null`
//   C) `collectorHealth.get('openclash.management')?.lastError === 'credentials_cleared'`
//   D) The next `client.readActiveConfigPath()` call performs no
//      fetches: `loadCredentials()` rejects before the cached-cookie
//      path can be used, which proves the cached cookie was
//      invalidated and the cleared credentials are authoritative.
//   E) That second call FAILS with `code: 'auth_error'` because the
//      credentials have been cleared. (LoadCredentials in the
//      management client throws `auth_error` when either secret
//      returns null/empty, which is exactly what we just produced.)
//
// References:
//   - .kiro/specs/network-quick-actions/design.md
//       §IPC Surface — `clearManagementCredentials`
//       §`openclash.management.service.ts` §Session caching
//   - .kiro/specs/network-quick-actions/requirements.md
//       Requirement 12.2 (clearing creds physically deletes rows)
//       Requirement 12.5 (clearing creds invalidates the cached session)
//   - src/main/ipc/index.ts §`clearManagementCredentials` handler
//
// Strategy
// --------
//
//   * Use better-sqlite3 ':memory:' driven through the production
//     `runMigrations` + `createRepositories` so the row under test
//     is written by the same `CollectorHealthRepository` used in
//     production (no test-only schema drift).
//   * Use the production `createSecretsModule` factory wired to a
//     plaintext-passthrough `SafeStorageLike` so the property covers
//     the real `secrets.set` / `secrets.get` / `secrets.remove`
//     surface — cipher choice is orthogonal to the deletion +
//     read-after-delete contract this property tests (Property 9
//     pins the cipher invariant separately).
//   * Use the production `createOpenClashManagementClient` factory
//     so the cookie-cache + 401-relogin semantics are exercised
//     end-to-end. The fake fetch is a counting state machine that
//     records every call so the property can assert "exactly one
//     login per priming cycle".
//   * Drive the orchestration steps directly (the IPC handler is a
//     thin wrapper around `removeSecret` + `invalidateSession` +
//     `recordFailure`; testing it through `ipcMain.handle` would
//     require an Electron stub that adds no coverage value here).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

let Database: typeof import('better-sqlite3');
let canRun = true;

try {
  Database = (await import('better-sqlite3')).default;
  // Quick probe — same pattern as the collector-health PBT to skip
  // when better-sqlite3 was compiled for Electron and the running
  // Node.js can't load it.
  const probe = new Database(':memory:');
  probe.close();
} catch {
  canRun = false;
}

const { runMigrations } = await import('../store/migrations');
const { createRepositories } = await import('../store/repositories');
const { createOpenClashManagementClient } = await import(
  '../services/openclash.management.service'
);
const { createSecretsModule } = await import('../security/secrets');

import type {
  SafeStorageLike,
  SecretsStore,
} from '../security/secrets';
import type { AppSettings } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTOR_KEY = 'openclash.management';
const USERNAME_KEY = 'openclash.management.username';
const PASSWORD_KEY = 'openclash.management.password';

/**
 * Sentinel string the IPC handler stamps onto `last_error` when the
 * user explicitly clears credentials. Mirrors the literal in
 * `src/main/ipc/index.ts` (`recordFailure(... , 'credentials_cleared')`).
 */
const CREDENTIALS_CLEARED_SENTINEL = 'credentials_cleared';

// ---------------------------------------------------------------------------
// Fake AppSettings
// ---------------------------------------------------------------------------

function buildSettings(): AppSettings {
  // Mirrors the baseline used by the other management-client PBTs.
  // The management URL is a real http(s) origin so `joinManagementUrl`
  // resolves to `http://192.168.31.100/cgi-bin/luci[...]`, which the
  // fake fetch routes by pathname.
  return {
    controllerUrl: 'http://192.168.31.100:9090',
    primaryGroups: ['🚀 节点选择'],
    probeUrls: ['https://www.google.com/generate_204'],
    routerHealth: { host: '192.168.31.100', port: 22 },
    switchVerifyDelayMs: 1000,
    switchConfirmation: false,
    refreshIntervals: {
      networkMs: 3_000,
      openclashMs: 3_000,
      currentNodeMs: 10_000,
      nodeScanMs: 60_000,
      usageMs: 60_000,
      retentionMs: 60 * 60 * 1_000,
    },
    collectors: { codex: { enabled: true } },
    autostart: false,
    configSwitchVerifyWindowMs: 8_000,
    managementInterface: {
      kind: 'openclash-luci',
      url: 'http://192.168.31.100',
      requestTimeoutMs: 10_000,
      configFileWhitelist: [],
    },
  } as AppSettings;
}

// ---------------------------------------------------------------------------
// Fake SafeStorage — plaintext passthrough
// ---------------------------------------------------------------------------
//
// Property 10 is about row deletion + cookie invalidation, not about
// the encryption invariant (Property 9 pins that). A plaintext
// passthrough keeps the test focused on the deletion + read-after-
// delete contract while still flowing through the production
// `createSecretsModule` factory.

function makePlaintextSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable(): boolean {
      return true;
    },
    encryptString(plainText: string): Buffer {
      return Buffer.from(plainText, 'utf-8');
    },
    decryptString(encrypted: Buffer): string {
      return encrypted.toString('utf-8');
    },
  };
}

function makeInMemoryStore(): SecretsStore {
  const map = new Map<string, Buffer>();
  return {
    getEncrypted(key: string): Buffer | null {
      return map.get(key) ?? null;
    },
    setEncrypted(key: string, value: Buffer): void {
      map.set(key, value);
    },
    deleteByKey(key: string): void {
      map.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Fake fetch — counting LuCI state machine
// ---------------------------------------------------------------------------
//
// Two endpoints suffice for this property:
//   * `POST /cgi-bin/luci` — the LuCI form login.
//   * `GET /cgi-bin/luci/admin/services/openclash/config_name`
//                         — the OpenClash plugin read endpoint.
//
// The fake counts both so the property can assert "cleared credentials
// trigger no fetches" and "re-setting credentials issues another
// login" (proves cookie invalidation), while the priming
// readActiveConfigPath issued at least one config read (proves the
// session was actually used before clearing).

interface FetchCounters {
  loginCalls: number;
  configReadCalls: number;
}

interface FakeFetchHandle {
  fetch: typeof fetch;
  counters: FetchCounters;
}

function buildFakeFetch(): FakeFetchHandle {
  const counters: FetchCounters = { loginCalls: 0, configReadCalls: 0 };
  let cookieCounter = 0;

  const configNameReply = JSON.stringify({
    config_name: [{ name: 'foo.yaml' }],
    config_path: 'foo.yaml',
  });

  const fakeFetch: typeof fetch = async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const path = new URL(url).pathname;

    // ---- LuCI login endpoint -------------------------------------------
    if (path === '/cgi-bin/luci') {
      counters.loginCalls += 1;
      // Always succeed at login when we get here. The "creds were
      // cleared" path short-circuits inside the management client's
      // `loadCredentials()` BEFORE issuing this fetch — the secrets
      // module returns `null` for both keys and the client throws
      // `auth_error` on its own. So if we reach this branch, the
      // secrets layer believes valid creds exist.
      cookieCounter += 1;
      return new Response('', {
        status: 200,
        headers: {
          'Set-Cookie': `sysauth=t${cookieCounter}; Path=/; HttpOnly`,
        },
      });
    }

    // ---- OpenClash plugin read endpoint --------------------------------
    if (path === '/cgi-bin/luci/admin/services/openclash/config_name') {
      counters.configReadCalls += 1;
      return new Response(configNameReply, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`fakeFetch: unexpected URL ${url}`);
  };

  return { fetch: fakeFetch, counters };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)(
  'clearManagementCredentials — Property 10 (network-quick-actions)',
  () => {
    it(
      'erases storage and invalidates the session for any (username, password) pair',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            // Both credentials are arbitrary non-empty strings —
            // the management client treats `null` and the empty
            // string as "credentials not configured", so any
            // length-≥-1 string represents the "configured" state
            // the priming step needs.
            fc.string({ minLength: 1 }),
            fc.string({ minLength: 1 }),
            async (username, password) => {
              // ---- Per-iteration setup ---------------------------------
              const db = new Database(':memory:');
              db.pragma('foreign_keys = ON');
              runMigrations(db);
              const repos = createRepositories(db);

              const safeStorage = makePlaintextSafeStorage();
              const store = makeInMemoryStore();
              const secrets = createSecretsModule({ store, safeStorage });

              const fakeFetchHandle = buildFakeFetch();
              const settings = buildSettings();

              // The test never advances `now` mid-iteration; the
              // property does not depend on relative timestamps,
              // only on the post-condition `lastError === 'credentials_cleared'`.
              const baseTs = 1_700_000_000_000;
              let currentNow = baseTs;

              const client = createOpenClashManagementClient({
                fetch: fakeFetchHandle.fetch,
                now: () => currentNow,
                secrets,
                collectorHealthRepo: repos.collectorHealth,
                // Never invoked by `readActiveConfigPath`; a `false`
                // stub keeps the closed-set error mapping intact in
                // case the implementation drifts.
                controllerHealthcheck: async () => false,
                getAppSettings: () => settings,
              });

              try {
                // ---- Step 1: configure both credentials -----------
                secrets.set(USERNAME_KEY, username);
                secrets.set(PASSWORD_KEY, password);

                // Sanity: the round-trip must work — Property 9
                // already pins the cipher invariant; we only need
                // to confirm the "configured" precondition holds.
                if (secrets.get(USERNAME_KEY) !== username) return false;
                if (secrets.get(PASSWORD_KEY) !== password) return false;

                // ---- Step 2: prime the session cookie ------------
                currentNow = baseTs + 1;
                const primingPath = await client.readActiveConfigPath();
                if (primingPath !== '/etc/openclash/config/foo.yaml') {
                  return false;
                }

                // The fake fetch must have observed exactly one
                // login + at least one config read during priming.
                if (fakeFetchHandle.counters.loginCalls !== 1) return false;
                if (fakeFetchHandle.counters.configReadCalls < 1) return false;

                const loginCallsAfterPriming =
                  fakeFetchHandle.counters.loginCalls;
                const configReadCallsAfterPriming =
                  fakeFetchHandle.counters.configReadCalls;

                // ---- Step 3: orchestration steps from the IPC handler ----
                //
                // Mirrors the body of the
                // `desktop:clearManagementCredentials` handler in
                // `src/main/ipc/index.ts`:
                //   1. removeSecret(username key)
                //   2. removeSecret(password key)
                //   3. client.invalidateSession()
                //   4. collectorHealth.recordFailure(
                //        COLLECTOR_KEY, now(), 'credentials_cleared').
                //
                // The handler also wraps step 4 with a `Date.now()`
                // call; we drive an explicit `currentNow` so the
                // property is timing-deterministic.
                currentNow = baseTs + 2;
                secrets.remove(USERNAME_KEY);
                secrets.remove(PASSWORD_KEY);
                client.invalidateSession();
                repos.collectorHealth.recordFailure(
                  COLLECTOR_KEY,
                  currentNow,
                  CREDENTIALS_CLEARED_SENTINEL,
                );

                // ---- Step 4: post-clear assertions ---------------
                // (A) username key returns null (Requirement 12.2).
                if (secrets.get(USERNAME_KEY) !== null) return false;
                // (B) password key returns null (Requirement 12.2).
                if (secrets.get(PASSWORD_KEY) !== null) return false;
                // (C) collector health reflects the sentinel
                //     (Requirement 12.5 / IPC handler contract).
                const healthRow = repos.collectorHealth.get(COLLECTOR_KEY);
                if (healthRow === undefined) return false;
                if (healthRow.lastError !== CREDENTIALS_CLEARED_SENTINEL) {
                  return false;
                }

                // ---- Step 5: drive a second readActiveConfigPath() ----
                //
                // The cached session cookie was just invalidated,
                // and the credentials have been wiped. The
                // management client's `loadCredentials()` checks the
                // secrets module BEFORE issuing any fetch, so it
                // must throw `auth_error` without reaching the LuCI
                // login endpoint at all.
                //
                // Even though no second login fetch is issued in
                // this clean-creds path, we still verify the cookie
                // invalidation behaviour via the assertion that
                // (D-implicit) the cookie is no longer cached: if
                // the management client somehow retained it, it
                // would never enter `loadCredentials()` to begin
                // with — the privileged-fetch path would proceed
                // straight to the cached cookie. The `auth_error`
                // outcome is the canonical observational signal of
                // both "creds cleared" AND "session invalidated".
                currentNow = baseTs + 3;
                let secondCallError: unknown = null;
                try {
                  await client.readActiveConfigPath();
                } catch (cause) {
                  secondCallError = cause;
                }
                // (E) Second call MUST have rejected — creds are gone.
                if (secondCallError === null) return false;
                if (
                  typeof secondCallError !== 'object' ||
                  secondCallError === null ||
                  !('code' in secondCallError) ||
                  (secondCallError as { code: unknown }).code !== 'auth_error'
                ) {
                  return false;
                }

                // (D) The fake fetch's counters must NOT show a
                // login attempt for the cleared-creds path —
                // because `loadCredentials` short-circuits before
                // any fetch is issued. This actually proves a
                // STRONGER claim than (D) above: not only was the
                // cookie invalidated, the secrets check happens
                // earlier still and prevents any privileged fetch
                // when creds are missing. So the post-clear login
                // counter must equal the priming-time login counter.
                if (
                  fakeFetchHandle.counters.loginCalls !== loginCallsAfterPriming
                ) {
                  return false;
                }
                // The config-read counter must also be unchanged for the
                // same reason.
                if (
                  fakeFetchHandle.counters.configReadCalls !==
                  configReadCallsAfterPriming
                ) {
                  return false;
                }

                // ---- Bonus: re-setting creds re-establishes a fresh session ----
                //
                // Demonstrates the cookie cache is genuinely empty
                // (not just shadowed by the cleared creds): re-
                // configuring the credentials and calling
                // readActiveConfigPath again must trigger a NEW
                // login (login counter += 1). This is the literal
                // task requirement "(and fails until creds re-set)".
                currentNow = baseTs + 4;
                secrets.set(USERNAME_KEY, username);
                secrets.set(PASSWORD_KEY, password);

                currentNow = baseTs + 5;
                const recoveredPath = await client.readActiveConfigPath();
                if (recoveredPath !== '/etc/openclash/config/foo.yaml') {
                  return false;
                }
                // A NEW login must have been issued — proves the
                // cookie cache was emptied by `invalidateSession`.
                if (
                  fakeFetchHandle.counters.loginCalls !==
                  loginCallsAfterPriming + 1
                ) {
                  return false;
                }
                if (
                  fakeFetchHandle.counters.configReadCalls <=
                  configReadCallsAfterPriming
                ) {
                  return false;
                }

                return true;
              } finally {
                db.close();
              }
            },
          ),
          { numRuns: 100 },
        );
      },
    );

    it(
      'sanity: a single example end-to-end flow exercises every assertion branch',
      async () => {
        // Example-based regression check that pins the orchestration
        // wiring independently of the property — useful when a
        // future refactor changes the order of the four
        // orchestration steps. The property's `false` returns
        // shrink to a counterexample but read as opaque
        // "predicate failed" failures; this example test is the
        // human-debug entry point.
        const db = new Database(':memory:');
        db.pragma('foreign_keys = ON');
        runMigrations(db);
        const repos = createRepositories(db);

        const safeStorage = makePlaintextSafeStorage();
        const store = makeInMemoryStore();
        const secrets = createSecretsModule({ store, safeStorage });

        const fakeFetchHandle = buildFakeFetch();
        const settings = buildSettings();
        const baseTs = 1_700_000_000_000;
        let currentNow = baseTs;

        const client = createOpenClashManagementClient({
          fetch: fakeFetchHandle.fetch,
          now: () => currentNow,
          secrets,
          collectorHealthRepo: repos.collectorHealth,
          controllerHealthcheck: async () => false,
          getAppSettings: () => settings,
        });

        try {
          // 1. Configure creds.
          secrets.set(USERNAME_KEY, 'admin');
          secrets.set(PASSWORD_KEY, 'sekret');

          // 2. Prime session cookie.
          currentNow = baseTs + 1;
          await expect(client.readActiveConfigPath()).resolves.toBe(
            '/etc/openclash/config/foo.yaml',
          );
          expect(fakeFetchHandle.counters.loginCalls).toBe(1);
          expect(fakeFetchHandle.counters.configReadCalls).toBeGreaterThanOrEqual(1);

          // 3. Clear creds via the four orchestration steps.
          currentNow = baseTs + 2;
          secrets.remove(USERNAME_KEY);
          secrets.remove(PASSWORD_KEY);
          client.invalidateSession();
          repos.collectorHealth.recordFailure(
            COLLECTOR_KEY,
            currentNow,
            CREDENTIALS_CLEARED_SENTINEL,
          );

          // 4. Post-clear assertions.
          expect(secrets.get(USERNAME_KEY)).toBeNull();
          expect(secrets.get(PASSWORD_KEY)).toBeNull();
          const row = repos.collectorHealth.get(COLLECTOR_KEY);
          expect(row).toBeDefined();
          expect(row!.lastError).toBe(CREDENTIALS_CLEARED_SENTINEL);

          // 5. Second call rejects with auth_error; no extra fetches.
          currentNow = baseTs + 3;
          await expect(client.readActiveConfigPath()).rejects.toMatchObject({
            code: 'auth_error',
          });
          expect(fakeFetchHandle.counters.loginCalls).toBe(1);

          // 6. Re-set creds → new login round trip.
          secrets.set(USERNAME_KEY, 'admin');
          secrets.set(PASSWORD_KEY, 'sekret');
          currentNow = baseTs + 4;
          await expect(client.readActiveConfigPath()).resolves.toBe(
            '/etc/openclash/config/foo.yaml',
          );
          expect(fakeFetchHandle.counters.loginCalls).toBe(2);
        } finally {
          db.close();
        }
      },
    );
  },
);
