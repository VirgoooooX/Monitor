// Feature: network-quick-actions, Property 5: Management client honors single-write, ≤3-verify, no-retry, closed error set.
//
// Validates Requirements 5.4, 5.6, 5.8, 5.9, 7.1, 7.2, 15.4, 15.5, 16.1, 16.3.
//
// Property: For any combination of (verify-window, request-timeout,
// write-success boolean, list of iteration outcomes) the management
// client's `switchActiveConfig` call satisfies the following six
// invariants drawn from design.md §`openclash.management.service.ts`
// §Verify and tasks.md §8.5:
//
//   1. AT MOST ONE write transaction. Across the whole call the fake
//      fetch sees `POST switch_config` AT MOST once
//      (Requirement 7.1, Property 8 carryover). When the write
//      sub-call fails the call returns immediately and every verify
//      read is skipped entirely (Requirement 5.6).
//
//   2. AT MOST 3 verify iterations. After write success the fake
//      fetch sees `GET config_name` AT MOST `VERIFY_MAX_ITERATIONS`
//      (3) additional times beyond the single pre-write read of the
//      start path (Requirement 15.4 / 15.5).
//
//   3. >= 1000 ms gap between consecutive verify reads. The fake
//      clock between any two consecutive verify-loop `config_name`
//      calls is at least `VERIFY_MIN_GAP_MS` (1000 ms). The first
//      verify read may follow the restart with no gap; only iteration
//      N+1 vs iteration N is bounded (design.md §`openclash
//      .management.service.ts` §Verify enforces the gap as a sleep
//      BETWEEN reads, not before the first one).
//
//   4. Total elapsed wall-clock <= verifyWindowMs + requestTimeoutMs.
//      The verify loop's own budget is `verifyWindowMs`; each in-
//      flight LuCI call can add up to one `requestTimeoutMs` worth of
//      waiting on a fake `now` controlled by the harness. Real
//      network latency is zero in the harness, but we still assert
//      the conservative loose bound the design pins for the
//      orchestrator's lock TTL.
//
//   5. Closed error set. When `result.ok === false` then
//      `result.error.code` is in `{ 'auth_error', 'http_error',
//      'network_error', 'verify_timeout', 'verify_mismatch',
//      'not_supported' }` (Requirement 16.1).
//
//   6. ok iff at least one verify iteration saw both `pathOk`
//      (re-read returned exactly `targetPath`) AND `apiOk`
//      (controllerHealthcheck returned true at least once during
//      the loop, with `apiOk` short-circuiting to true once observed
//      per design.md). When NO iteration saw both, `result.ok` is
//      false and `result.error.code` is `'verify_timeout'`
//      (Requirement 15.5 groups "3 reads exhausted" and "window
//      elapsed" under the same code).
//
// Transport
// ---------
//
// As of the 2026-05-28 transport rewrite (see
// `docs/postmortems/openclash-management-transport.md`) the management
// client talks to OpenClash via the LuCI plugin's own HTTP endpoints
// (`config_name` / `switch_config`) instead of LuCI ubus's `uci.set`
// + `uci.commit` + `file.exec`. This test mirrors that contract: the
// fake fetch routes by pathname and the property's "single write"
// invariant counts a single `POST switch_config` instead of three
// ubus sub-calls.
//
// References:
//   - .kiro/specs/network-quick-actions/design.md §Property 5
//   - .kiro/specs/network-quick-actions/requirements.md
//       Requirement 5.4, 5.6, 5.8, 5.9 (verify-window, error mapping)
//       Requirement 7.1, 7.2 (no auto-retry on the write step)
//       Requirement 15.4, 15.5 (≤1 write, ≤3 verify reads, ≥1000 ms gap)
//       Requirement 16.1 (closed `ManagementErrorCode` set)
//       Requirement 16.3 (verify_timeout / verify_mismatch use)
//
// Strategy
// --------
//
//   * Use better-sqlite3 ':memory:' driven through the production
//     `runMigrations` + `createRepositories` factory so the
//     `openclash.management` row is written by the same
//     `CollectorHealthRepository` used in production.
//   * Inject a fake `fetch` programmable per OpenClash plugin
//     endpoint plus a programmable login outcome.
//   * Inject a fake `now` + fake `sleep` that share a single
//     `clock` variable. `sleep(ms)` advances the clock by `ms` and
//     resolves immediately; `now()` returns the current clock. This
//     turns the verify loop's gap accounting into an algebraic
//     property over the recorded read timestamps.
//   * Inject a fake `controllerHealthcheck` driven by a per-iteration
//     boolean schedule.
//   * Run >= 100 cases per fast-check property contract.
//
// NOTES
// -----
//
//   * The fake fetch is a counting state machine — every call is
//     recorded in a flat array of `{ pathname, method }` records so
//     the property can directly count `config_name` reads and
//     `switch_config` writes by inspecting the pathname.
//   * The fake fetch is deliberately NOT given any per-call latency:
//     `now()` advances ONLY when the verify loop calls `sleep(gap)`.
//     This makes "elapsed time" identically equal to "total sleep
//     time", which is the bound design.md §`switchActiveConfig`
//     §Verify pins (the loop's own budget; per-call wall-clock is
//     handled by `AbortSignal.timeout` and is independent of the
//     fake clock).

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
  './openclash.management.service'
);
const types = await import('./openclash.management.service');

import type { SecretsModule } from '../security/secrets';
import type { AppSettings } from '../types';

type ManagementErrorCode = types.ManagementErrorCode;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGET_PATH = '/etc/openclash/config/target.yaml';

const VERIFY_MAX_ITERATIONS = 3;
const VERIFY_MIN_GAP_MS = 1000;

const CLOSED_ERROR_CODES: readonly ManagementErrorCode[] = [
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
  'not_supported',
];

// ---------------------------------------------------------------------------
// Fake AppSettings + SecretsModule
// ---------------------------------------------------------------------------

function buildSettings(input: {
  verifyWindowMs: number;
  requestTimeoutMs: number;
}): AppSettings {
  // Mirrors the schema-test baseline (intentionally omits `cliproxy`
  // for parity with `schemas.test.ts` — the management client never
  // reads that field, and the property's invariants are independent
  // of unrelated settings).
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
    configSwitchVerifyWindowMs: input.verifyWindowMs,
    managementInterface: {
      kind: 'openclash-luci',
      url: 'http://192.168.31.100',
      requestTimeoutMs: input.requestTimeoutMs,
      configFileWhitelist: [],
    },
  } as AppSettings;
}

const fakeSecrets: SecretsModule = {
  isAvailable() {
    return true;
  },
  set() {
    /* unused */
  },
  get(key) {
    if (key === 'openclash.management.username') return 'admin';
    if (key === 'openclash.management.password') return 'password';
    return null;
  },
  remove() {
    /* unused */
  },
};

// ---------------------------------------------------------------------------
// Iteration-outcome arbitraries
// ---------------------------------------------------------------------------

/** What the fake's `config_name` GET returns on a given verify iteration. */
type PathOutcome = 'targetPath' | 'wrongPath' | 'http_error' | 'network_error';

interface IterationOutcome {
  pathReturns: PathOutcome;
  apiOk: boolean;
}

interface PropertyInput {
  verifyWindowMs: number;
  requestTimeoutMs: number;
  writeSucceeds: boolean;
  /**
   * How the write call (`POST switch_config`) fails when
   * `writeSucceeds === false`. The plugin endpoint surfaces three
   * shapes the management client maps onto distinct closed-set
   * codes:
   *   - `'http_error'`    — non-2xx response   (mapped to `http_error`)
   *   - `'auth_error'`    — 401 after re-login (mapped to `auth_error`)
   *   - `'network_error'` — fetch throws       (mapped to `network_error`)
   *   - `'plugin_error'`  — 200 with body `{status:"error",...}`
   *                          (mapped to `http_error`)
   */
  writeFailureKind:
    | 'http_error'
    | 'auth_error'
    | 'network_error'
    | 'plugin_error';
  /** Verify-loop schedule. Length 1..5; the implementation caps at 3. */
  iterationOutcomes: IterationOutcome[];
}

const pathOutcomeArb: fc.Arbitrary<PathOutcome> = fc.constantFrom<PathOutcome>(
  'targetPath',
  'wrongPath',
  'http_error',
  'network_error',
);

const iterationOutcomeArb: fc.Arbitrary<IterationOutcome> = fc.record({
  pathReturns: pathOutcomeArb,
  apiOk: fc.boolean(),
});

const propertyInputArb: fc.Arbitrary<PropertyInput> = fc.record({
  verifyWindowMs: fc.integer({ min: 1_000, max: 30_000 }),
  requestTimeoutMs: fc.integer({ min: 1_000, max: 30_000 }),
  writeSucceeds: fc.boolean(),
  writeFailureKind: fc.constantFrom<
    'http_error' | 'auth_error' | 'network_error' | 'plugin_error'
  >('http_error', 'auth_error', 'network_error', 'plugin_error'),
  iterationOutcomes: fc.array(iterationOutcomeArb, { minLength: 1, maxLength: 5 }),
});

// ---------------------------------------------------------------------------
// Fake clock + fake sleep
// ---------------------------------------------------------------------------

interface FakeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Strictly increasing log of clock readings at each `sleep()` exit. */
  readonly sleeps: number[];
}

function buildFakeClock(start: number): FakeClock {
  let clock = start;
  const sleeps: number[] = [];
  return {
    now: () => clock,
    sleep(ms: number): Promise<void> {
      // Treat negative / zero as a no-op — matches the production
      // `sleep` fallback semantics in `openclash.management.service.ts`.
      if (ms > 0) {
        clock += ms;
      }
      sleeps.push(clock);
      return Promise.resolve();
    },
    sleeps,
  };
}

// ---------------------------------------------------------------------------
// Fake fetch — counting LuCI / OpenClash plugin state machine
// ---------------------------------------------------------------------------

/** A single fetch invocation captured for property assertions. */
interface FetchRecord {
  /** Pathname only (host stripped) — the management URL is fixed. */
  pathname: string;
  /** Upper-cased HTTP method. */
  method: string;
  /**
   * High-level call kind, derived from `(pathname, method)`. Lets
   * the property count writes / reads / logins without re-parsing
   * the pathname.
   */
  kind: 'login' | 'config_name' | 'switch_config' | 'other';
  /** Wall-clock time the request was issued (from the fake `now()`). */
  at: number;
}

interface FakeFetchHandle {
  fetch: typeof fetch;
  records: ReadonlyArray<FetchRecord>;
}

function classifyCall(pathname: string, method: string): FetchRecord['kind'] {
  if (pathname === '/cgi-bin/luci' && method === 'POST') {
    return 'login';
  }
  if (pathname === '/cgi-bin/luci/admin/services/openclash/config_name') {
    return 'config_name';
  }
  if (pathname === '/cgi-bin/luci/admin/services/openclash/switch_config') {
    return 'switch_config';
  }
  return 'other';
}

function buildFakeFetch(
  input: PropertyInput,
  clock: FakeClock,
): FakeFetchHandle {
  const records: FetchRecord[] = [];
  // Track whether the pre-write `config_name` read has been served.
  // Subsequent `config_name` calls are verify-loop reads, indexed
  // 0..N-1 into `iterationOutcomes`.
  let preWriteReadConsumed = false;
  let verifyIterationIndex = 0;

  const jsonOk = (data: Record<string, unknown>): Response =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const fakeFetch: typeof fetch = async (request, init) => {
    const url =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.toString()
          : (request as Request).url;
    const pathname = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const kind = classifyCall(pathname, method);

    records.push({ pathname, method, kind, at: clock.now() });

    // ---- LuCI login ------------------------------------------------------
    if (kind === 'login') {
      // Always succeed at login — the property does not exercise
      // the auth_error→relogin path on the LuCI form (the
      // collector-health PBT covers that). Failed-write outcomes
      // are surfaced through the plugin endpoint's HTTP/JSON shape.
      return new Response('', {
        status: 200,
        headers: { 'Set-Cookie': 'sysauth=token1; Path=/; HttpOnly' },
      });
    }

    // ---- Read: GET config_name -------------------------------------------
    if (kind === 'config_name') {
      if (!preWriteReadConsumed) {
        // First `config_name` call is the implementation's pre-
        // write read of the start path. Return a path that is NOT
        // `targetPath` so `startPath !== targetPath`; this is
        // observability only, the property never asserts on
        // `startPath`. The plugin returns basenames, which the
        // client normalises via `canonicalConfigPath()`.
        preWriteReadConsumed = true;
        return jsonOk({
          config_name: [{ name: 'wrong.yaml' }, { name: 'target.yaml' }],
          config_path: 'wrong.yaml',
        });
      }

      // Subsequent calls are verify-loop reads.
      const idx = verifyIterationIndex;
      verifyIterationIndex += 1;
      const outcome =
        idx < input.iterationOutcomes.length
          ? input.iterationOutcomes[idx]
          : null;
      if (outcome === null) {
        // Test-plumbing bug: implementation issued more verify reads
        // than the schedule provides for. Surface as 500 so fast-
        // check shrinks to a counterexample.
        return new Response('', { status: 500 });
      }
      if (outcome.pathReturns === 'targetPath') {
        return jsonOk({
          config_name: [{ name: 'wrong.yaml' }, { name: 'target.yaml' }],
          config_path: 'target.yaml',
        });
      }
      if (outcome.pathReturns === 'wrongPath') {
        return jsonOk({
          config_name: [{ name: 'wrong.yaml' }, { name: 'target.yaml' }],
          config_path: 'wrong.yaml',
        });
      }
      if (outcome.pathReturns === 'http_error') {
        return new Response('', { status: 500 });
      }
      // 'network_error' — throw a TypeError mirroring Node's
      // fetch network-failure shape.
      const cause = Object.assign(new Error('ECONNREFUSED'), {
        name: 'Error',
      });
      const err = new TypeError('fetch failed');
      Object.assign(err, { cause });
      throw err;
    }

    // ---- Write: POST switch_config ---------------------------------------
    if (kind === 'switch_config') {
      if (input.writeSucceeds) {
        return jsonOk({
          status: 'success',
          message: 'Config file switched successfully',
          config_file: TARGET_PATH,
        });
      }
      if (input.writeFailureKind === 'http_error') {
        return new Response('', { status: 500 });
      }
      if (input.writeFailureKind === 'auth_error') {
        // Returning 401 from the write endpoint forces
        // privilegedFetch's transparent re-login; with the login
        // endpoint always succeeding above, the retry will land here
        // again and the management client maps the second 401 to
        // `auth_error`.
        return new Response('', { status: 401 });
      }
      if (input.writeFailureKind === 'plugin_error') {
        // 200 with `{status:"error",...}` — the plugin handler's
        // refusal shape (e.g. "config file does not exist"). Mapped
        // to `http_error` by the management client.
        return jsonOk({
          status: 'error',
          message: 'Config file does not exist',
        });
      }
      // 'network_error' — fetch throws.
      const cause = Object.assign(new Error('ECONNREFUSED'), {
        name: 'Error',
      });
      const err = new TypeError('fetch failed');
      Object.assign(err, { cause });
      throw err;
    }

    throw new Error(`fakeFetch: unexpected URL ${url}`);
  };

  return { fetch: fakeFetch, records };
}

// ---------------------------------------------------------------------------
// Helpers — derive the expected outcome from the input
// ---------------------------------------------------------------------------

/**
 * Compute the implementation-equivalent expected ok/code from the
 * generated input. This lets the property assert on the call's
 * result independently of the fake fetch's record array.
 *
 * The verify loop's iteration count is bounded by both
 * `VERIFY_MAX_ITERATIONS` and the `verifyWindowMs` budget. Each
 * iteration N >= 1 sleeps `VERIFY_MIN_GAP_MS` before its read; the
 * loop bails out when `(N) * VERIFY_MIN_GAP_MS >= verifyWindowMs`.
 * Equivalently, the highest accessible iteration index is the
 * largest N with `N * VERIFY_MIN_GAP_MS < verifyWindowMs`, which
 * gives `accessible = ceil(verifyWindowMs / VERIFY_MIN_GAP_MS)` (or
 * `VERIFY_MAX_ITERATIONS`, whichever is smaller).
 *
 * Because the fake fetch's per-call latency is zero, the fake clock
 * advances only via `sleep(VERIFY_MIN_GAP_MS)`. This makes the time-
 * budget calculation an exact algebraic property over the iteration
 * index, independent of `requestTimeoutMs`.
 */
function expectedOutcome(input: PropertyInput): {
  ok: boolean;
  expectedCode?: ManagementErrorCode;
} {
  if (!input.writeSucceeds) {
    // Closed-set mapping for the four write failure kinds:
    //   * 'http_error'    → 'http_error'    (HTTP 5xx from the plugin endpoint)
    //   * 'auth_error'    → 'auth_error'    (401 even after re-login)
    //   * 'network_error' → 'network_error' (fetch throws)
    //   * 'plugin_error'  → 'http_error'    (200 with `{status:"error"}`)
    const code: ManagementErrorCode =
      input.writeFailureKind === 'plugin_error'
        ? 'http_error'
        : input.writeFailureKind;
    return { ok: false, expectedCode: code };
  }

  const accessibleIterations = Math.min(
    VERIFY_MAX_ITERATIONS,
    Math.ceil(input.verifyWindowMs / VERIFY_MIN_GAP_MS),
  );
  const usedIterations = Math.min(
    input.iterationOutcomes.length,
    accessibleIterations,
  );

  let apiOkSeen = false;
  for (let i = 0; i < usedIterations; i += 1) {
    const o = input.iterationOutcomes[i];
    const pathOk = o.pathReturns === 'targetPath';
    if (o.apiOk) {
      apiOkSeen = true;
    }
    if (pathOk && apiOkSeen) {
      return { ok: true };
    }
  }
  return { ok: false, expectedCode: 'verify_timeout' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)(
  'OpenClashManagementClient — Property 5 (network-quick-actions)',
  () => {
    it('switchActiveConfig honors single-write, ≤3-verify, no-retry, closed error set', async () => {
      await fc.assert(
        fc.asyncProperty(propertyInputArb, async (input) => {
          // ---- Per-iteration setup ---------------------------------------
          const db = new Database(':memory:');
          db.pragma('foreign_keys = ON');
          runMigrations(db);
          const repos = createRepositories(db);

          const baseTs = 1_700_000_000_000;
          const clock = buildFakeClock(baseTs);
          const fakeFetchHandle = buildFakeFetch(input, clock);

          // Schedule of controllerHealthcheck answers driven by the
          // iteration-outcome list. The implementation short-circuits
          // once it has seen `apiOk === true` at least once, so we
          // hand out one boolean per call. We never report a
          // healthcheck rejection — the implementation already
          // catches `apiPromise` rejections; a rejected promise is
          // observationally equivalent to a `false` answer for the
          // closed-set mapping the property cares about.
          let healthcheckCallIndex = 0;

          const settings = buildSettings({
            verifyWindowMs: input.verifyWindowMs,
            requestTimeoutMs: input.requestTimeoutMs,
          });

          const client = createOpenClashManagementClient({
            fetch: fakeFetchHandle.fetch,
            now: clock.now,
            sleep: clock.sleep,
            secrets: fakeSecrets,
            collectorHealthRepo: repos.collectorHealth,
            controllerHealthcheck: async () => {
              const idx = healthcheckCallIndex;
              healthcheckCallIndex += 1;
              if (idx < input.iterationOutcomes.length) {
                return input.iterationOutcomes[idx].apiOk;
              }
              return false;
            },
            getAppSettings: () => settings,
          });

          // ---- Drive the call ---------------------------------------------
          const tStart = clock.now();
          const result = await client.switchActiveConfig({
            targetPath: TARGET_PATH,
            verifyWindowMs: input.verifyWindowMs,
            requestTimeoutMs: input.requestTimeoutMs,
          });
          const tEnd = clock.now();

          // ---- Inspect the recorded call sequence -------------------------
          const records = fakeFetchHandle.records;

          // Count switch_config writes by kind.
          const writeCount = records.filter(
            (r) => r.kind === 'switch_config',
          ).length;

          // Collect config_name records in order. The first is the
          // pre-write start-path read; the rest belong to the verify
          // loop.
          const configNameRecords = records.filter(
            (r) => r.kind === 'config_name',
          );
          const verifyReads = configNameRecords.slice(1);

          // ---- Invariant 1: AT MOST ONE write transaction ----------------
          // The plugin endpoint is invoked at most once. The
          // implementation never auto-retries the write step
          // (Requirement 7.1).
          if (writeCount > 1) {
            db.close();
            return false;
          }

          if (input.writeSucceeds) {
            // Exactly one write must have run; otherwise the verify
            // loop would have been skipped.
            if (writeCount !== 1) {
              db.close();
              return false;
            }
          } else {
            // Write failure: exactly one write attempt; no verify
            // reads issued (Requirement 5.6).
            if (writeCount !== 1) {
              db.close();
              return false;
            }
            if (verifyReads.length !== 0) {
              db.close();
              return false;
            }
          }

          // ---- Invariant 2: ≤ 3 verify iterations ------------------------
          if (verifyReads.length > VERIFY_MAX_ITERATIONS) {
            db.close();
            return false;
          }

          // ---- Invariant 3: ≥ 1000 ms gap between consecutive verify reads
          for (let i = 1; i < verifyReads.length; i += 1) {
            const gap = verifyReads[i].at - verifyReads[i - 1].at;
            if (gap < VERIFY_MIN_GAP_MS) {
              db.close();
              return false;
            }
          }

          // ---- Invariant 4: total elapsed <= window + requestTimeout -----
          // Loose bound from design.md §`switchActiveConfig` §Verify.
          // The fake clock advances ONLY when the implementation
          // calls `sleep(ms)`, so this is exactly the sum of
          // verify-loop sleep durations.
          const elapsed = tEnd - tStart;
          if (elapsed > input.verifyWindowMs + input.requestTimeoutMs) {
            db.close();
            return false;
          }

          // ---- Invariant 5: closed error set -----------------------------
          if (!result.ok) {
            const code = result.error?.code ?? null;
            if (code === null || !CLOSED_ERROR_CODES.includes(code)) {
              db.close();
              return false;
            }
          }

          // ---- Invariant 6: ok iff some iteration saw pathOk + apiOk -----
          const expected = expectedOutcome(input);
          if (result.ok !== expected.ok) {
            db.close();
            return false;
          }
          if (!result.ok && expected.expectedCode !== undefined) {
            if (result.error?.code !== expected.expectedCode) {
              db.close();
              return false;
            }
          }

          db.close();
          return true;
        }),
        { numRuns: 100 },
      );
    });

    it('sanity: write-success + first-iteration pathOk+apiOk returns ok', async () => {
      // Example-based regression that pins the canonical happy path
      // (one of the simplest schedules the property's combinatorial
      // search would otherwise have to find).
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      const repos = createRepositories(db);

      const clock = buildFakeClock(1_700_000_000_000);
      const input: PropertyInput = {
        verifyWindowMs: 8_000,
        requestTimeoutMs: 10_000,
        writeSucceeds: true,
        writeFailureKind: 'http_error',
        iterationOutcomes: [{ pathReturns: 'targetPath', apiOk: true }],
      };
      const fakeFetchHandle = buildFakeFetch(input, clock);
      const settings = buildSettings({
        verifyWindowMs: input.verifyWindowMs,
        requestTimeoutMs: input.requestTimeoutMs,
      });

      let healthcheckCalls = 0;
      const client = createOpenClashManagementClient({
        fetch: fakeFetchHandle.fetch,
        now: clock.now,
        sleep: clock.sleep,
        secrets: fakeSecrets,
        collectorHealthRepo: repos.collectorHealth,
        controllerHealthcheck: async () => {
          healthcheckCalls += 1;
          return true;
        },
        getAppSettings: () => settings,
      });

      const result = await client.switchActiveConfig({
        targetPath: TARGET_PATH,
        verifyWindowMs: input.verifyWindowMs,
        requestTimeoutMs: input.requestTimeoutMs,
      });

      expect(result.ok).toBe(true);
      expect(result.targetPath).toBe(TARGET_PATH);
      expect(result.finalPath).toBe(TARGET_PATH);

      // Exactly one POST switch_config.
      const records = fakeFetchHandle.records;
      expect(records.filter((r) => r.kind === 'switch_config').length).toBe(1);

      // First verify iteration short-circuits (apiOk + pathOk).
      const verifyReads = records
        .filter((r) => r.kind === 'config_name')
        .slice(1);
      expect(verifyReads.length).toBe(1);
      expect(healthcheckCalls).toBe(1);

      db.close();
    });

    it('sanity: write failure short-circuits with the closed-set code and skips verify', async () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      const repos = createRepositories(db);

      const clock = buildFakeClock(1_700_000_000_000);
      const input: PropertyInput = {
        verifyWindowMs: 8_000,
        requestTimeoutMs: 10_000,
        writeSucceeds: false,
        writeFailureKind: 'auth_error',
        iterationOutcomes: [{ pathReturns: 'targetPath', apiOk: true }],
      };
      const fakeFetchHandle = buildFakeFetch(input, clock);
      const settings = buildSettings({
        verifyWindowMs: input.verifyWindowMs,
        requestTimeoutMs: input.requestTimeoutMs,
      });

      const client = createOpenClashManagementClient({
        fetch: fakeFetchHandle.fetch,
        now: clock.now,
        sleep: clock.sleep,
        secrets: fakeSecrets,
        collectorHealthRepo: repos.collectorHealth,
        controllerHealthcheck: async () => true,
        getAppSettings: () => settings,
      });

      const result = await client.switchActiveConfig({
        targetPath: TARGET_PATH,
        verifyWindowMs: input.verifyWindowMs,
        requestTimeoutMs: input.requestTimeoutMs,
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('auth_error');
      expect(CLOSED_ERROR_CODES).toContain(result.error!.code);

      // Exactly one switch_config attempt; no verify reads
      // (Requirement 5.6 — write failure skips the verify loop).
      const records = fakeFetchHandle.records;
      expect(records.filter((r) => r.kind === 'switch_config').length).toBe(1);
      const verifyReads = records
        .filter((r) => r.kind === 'config_name')
        .slice(1);
      expect(verifyReads.length).toBe(0);

      db.close();
    });

    it('sanity: schedule with no pathOk+apiOk overlap returns verify_timeout', async () => {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      const repos = createRepositories(db);

      const clock = buildFakeClock(1_700_000_000_000);
      const input: PropertyInput = {
        verifyWindowMs: 8_000,
        requestTimeoutMs: 10_000,
        writeSucceeds: true,
        writeFailureKind: 'http_error',
        iterationOutcomes: [
          { pathReturns: 'wrongPath', apiOk: true },
          { pathReturns: 'wrongPath', apiOk: true },
          { pathReturns: 'wrongPath', apiOk: true },
        ],
      };
      const fakeFetchHandle = buildFakeFetch(input, clock);
      const settings = buildSettings({
        verifyWindowMs: input.verifyWindowMs,
        requestTimeoutMs: input.requestTimeoutMs,
      });

      const client = createOpenClashManagementClient({
        fetch: fakeFetchHandle.fetch,
        now: clock.now,
        sleep: clock.sleep,
        secrets: fakeSecrets,
        collectorHealthRepo: repos.collectorHealth,
        controllerHealthcheck: async () => true,
        getAppSettings: () => settings,
      });

      const result = await client.switchActiveConfig({
        targetPath: TARGET_PATH,
        verifyWindowMs: input.verifyWindowMs,
        requestTimeoutMs: input.requestTimeoutMs,
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('verify_timeout');

      const records = fakeFetchHandle.records;
      const verifyReads = records
        .filter((r) => r.kind === 'config_name')
        .slice(1);
      // Verify capped at the iteration limit.
      expect(verifyReads.length).toBeLessThanOrEqual(VERIFY_MAX_ITERATIONS);
      // Each consecutive pair is at least 1000ms apart.
      for (let i = 1; i < verifyReads.length; i += 1) {
        expect(verifyReads[i].at - verifyReads[i - 1].at).toBeGreaterThanOrEqual(
          VERIFY_MIN_GAP_MS,
        );
      }

      db.close();
    });
  },
);
