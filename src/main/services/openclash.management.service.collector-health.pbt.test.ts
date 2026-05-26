// Feature: network-quick-actions, Property 13: collector_health.openclash.management counters track outcomes.
//
// Validates Requirements 14.1, 14.2, 14.3.
//
// Property: For any finite, monotonically-timestamped sequence of
// `OpenClashManagementClient.readActiveConfigPath()` calls with a mix
// of success / failure outcomes, after the sequence the
// `collector_health` row keyed `openclash.management` satisfies:
//
//   * `last_run_at`         === timestamp of the latest call.
//   * `last_success_at`     === timestamp of the latest success
//                              (or null when the sequence has none).
//   * `consecutive_failures` === count of consecutive failures from
//                              the END of the sequence (resets to 0
//                              the moment a success is encountered
//                              when scanning backwards).
//   * `last_error`          === ManagementErrorCode of the most
//                              recent failure SINCE the last success,
//                              or null when the trace's tail is a
//                              success (or all calls are successful).
//   * `last_error_at`       === timestamp of that same failure (null
//                              under the same conditions).
//
// The tail-relative semantic for `last_error` / `last_error_at` is
// the existing `CollectorHealthRepository.recordSuccess` contract:
// every success clears `last_error` and `last_error_at` to NULL
// (alongside resetting `consecutive_failures` to 0). The Property 13
// design statement leans on this contract — see the "depends on the
// existing repo's contract; check it" note in tasks.md §8.6, and the
// SQL in `repositories.ts` `recordSuccess` for the source of truth.
//
// References:
//   - .kiro/specs/network-quick-actions/design.md §Property 13
//   - .kiro/specs/network-quick-actions/requirements.md
//       Requirement 14.1, 14.2, 14.3, 14.5, 16.1
//
// Strategy:
//
//   * Use better-sqlite3 ':memory:' driven through the production
//     `runMigrations` + `createRepositories` factory so the row
//     under test is written by the SAME `CollectorHealthRepository`
//     used in production (no test-only schema drift).
//   * Inject a fake `fetch` and a fake `now` so each step in the
//     generated trace deterministically drives one closed-set
//     outcome (`success`, `http_error`, `network_error`, `auth_error`)
//     against a programmable LuCI surface. The fake fetch is a
//     two-endpoint state machine — `/cgi-bin/luci` (login) and
//     `/cgi-bin/luci/ubus/` (ubus call) — keyed on `currentOutcome`
//     so a single in-test toggle per step covers both transports.
//   * Drive 1..20 steps per run (the spec's stated bound) with
//     strictly increasing timestamps. After each call, recompute the
//     property's expected row from the trace and assert pointwise
//     equality against the persisted row.
//   * Run >=100 cases per fast-check property contract.
//
// NOTES on the fake fetch's outcome semantics
// -------------------------------------------
//
// The management client's `readActiveConfigPath` flow is:
//
//   1. ensureSession(): if no cached cookie, POST /cgi-bin/luci
//      with form-encoded creds and capture sysauth cookie.
//   2. ubusCall(): POST /cgi-bin/luci/ubus/ with the cached cookie.
//      On 401 the privilegedFetch helper invalidates the cookie,
//      logs back in once, and retries the request exactly once.
//
// The four outcomes therefore map onto the fake fetch as follows:
//
//   * success      — login: 200 + Set-Cookie. ubus: 200 + valid envelope.
//   * http_error   — login: 200 + Set-Cookie. ubus: 500 (any non-2xx
//                    non-401). The privilegedFetch helper returns it
//                    verbatim and ubusCall maps to `http_error`.
//   * network_error — login: 200 + Set-Cookie. ubus: throws TypeError.
//                    privilegedFetch wraps as `network_error`.
//   * auth_error   — login: 401 (no cookie); ubus: 401. Either the
//                    initial ensureSession login fails (first call,
//                    no cached cookie) or the ubus 401 → invalidate
//                    cookie → re-login fails path triggers; both
//                    surface `auth_error`.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

let Database: typeof import('better-sqlite3');
let canRun = true;

try {
  Database = (await import('better-sqlite3')).default;
  // Quick probe: open + close to confirm the native binding is usable
  // against the running Node.js. When better-sqlite3 has been compiled
  // for Electron the NODE_MODULE_VERSION mismatch lands here and we
  // skip the suite — same pattern used by `store/repositories.test.ts`.
  const probe = new Database(':memory:');
  probe.close();
} catch {
  canRun = false;
}

const { runMigrations } = await import('../store/migrations');
const { createRepositories } = await import('../store/repositories');
const { createOpenClashManagementClient } = await import('./openclash.management.service');
const types = await import('./openclash.management.service');

import type { SecretsModule } from '../security/secrets';
import type { AppSettings } from '../types';

type ManagementErrorCode = types.ManagementErrorCode;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTOR_KEY = 'openclash.management';

/**
 * The closed `ManagementErrorCode` set the test asserts `last_error`
 * stays inside. Mirrors the union in `openclash.management.service.ts`
 * so that drift between the union and this allowlist is caught at
 * compile time.
 */
const CLOSED_ERROR_CODES: readonly ManagementErrorCode[] = [
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
  'not_supported',
];

/** Outcomes the test programs the fake fetch to deliver per step. */
type Outcome = 'success' | 'http_error' | 'network_error' | 'auth_error';

/** The closed-set error code each non-success outcome surfaces. */
const OUTCOME_TO_CODE: Record<Exclude<Outcome, 'success'>, ManagementErrorCode> = {
  http_error: 'http_error',
  network_error: 'network_error',
  auth_error: 'auth_error',
};

// ---------------------------------------------------------------------------
// Fake AppSettings + SecretsModule
// ---------------------------------------------------------------------------

function buildSettings(): AppSettings {
  // Mirrors the schema-test baseline (intentionally omits `cliproxy`
  // for parity with `schemas.test.ts` — the management client never
  // reads that field). The `managementInterface.url` is a real
  // http(s) origin so `joinManagementUrl` lands at
  // `http://192.168.31.100/cgi-bin/luci[...]`, which the fake fetch
  // routes by pathname.
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

/**
 * Minimal `SecretsModule` stub — returns the canonical 'admin' /
 * 'password' credentials so the LuCI login path can succeed when the
 * outcome is anything other than `auth_error`.
 *
 * Defined at module scope (not inside the property) so each iteration
 * resolves credentials in <1 µs; the property runs >=100 times.
 */
const fakeSecrets: SecretsModule = {
  isAvailable() {
    return true;
  },
  set() {
    /* unused in the read-only test path */
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
// Fake fetch — programmable per-step state machine
// ---------------------------------------------------------------------------

interface FakeFetchHandle {
  fetch: typeof fetch;
  /** Test sets this before each call to drive the fake's outcome. */
  setOutcome(o: Outcome): void;
}

function buildFakeFetch(): FakeFetchHandle {
  let currentOutcome: Outcome = 'success';
  let cookieCounter = 0;

  const ubusSuccessBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: [0, { value: '/etc/openclash/config/foo.yaml' }],
  });

  const fakeFetch: typeof fetch = async (input, _init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const path = new URL(url).pathname;

    // ---- LuCI login endpoint ---------------------------------------------
    if (path === '/cgi-bin/luci') {
      if (currentOutcome === 'auth_error') {
        // Empty body, no Set-Cookie — LuCI's "credentials rejected"
        // shape from the client's perspective.
        return new Response('', { status: 401 });
      }
      // Successful login: rotate the cookie name so a re-login after
      // an invalidated cache delivers a fresh sysauth value.
      cookieCounter += 1;
      return new Response('', {
        status: 200,
        headers: {
          'Set-Cookie': `sysauth=t${cookieCounter}; Path=/; HttpOnly`,
        },
      });
    }

    // ---- LuCI ubus endpoints ---------------------------------------------
    if (
      path === '/cgi-bin/luci/ubus/' ||
      path === '/cgi-bin/luci/admin/ubus/'
    ) {
      if (currentOutcome === 'success') {
        return new Response(ubusSuccessBody, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (currentOutcome === 'http_error') {
        return new Response('', { status: 500 });
      }
      if (currentOutcome === 'network_error') {
        // Mirrors Node fetch's network-failure shape (TypeError with a
        // cause). `classifyFetchCause` in the management client reads
        // the cause's `name` field to compose the audit-safe tag.
        const cause = Object.assign(new Error('ECONNREFUSED'), {
          name: 'Error',
        });
        const err = new TypeError('fetch failed');
        Object.assign(err, { cause });
        throw err;
      }
      // currentOutcome === 'auth_error': both the initial ubus call
      // and the privilegedFetch retry land here. Returning 401 from
      // the retry too triggers `ubusCall`'s `auth_error` mapping if
      // the re-login somehow succeeded; in practice the re-login
      // hits the login endpoint (401 above) and throws first.
      return new Response('', { status: 401 });
    }

    throw new Error(`fakeFetch: unexpected URL ${url}`);
  };

  return {
    fetch: fakeFetch,
    setOutcome(o: Outcome): void {
      currentOutcome = o;
    },
  };
}

// ---------------------------------------------------------------------------
// Trace evaluation — pure derivation of the expected row
// ---------------------------------------------------------------------------

interface TraceEntry {
  outcome: Outcome;
  ts: number;
  /** Present iff `outcome !== 'success'`. */
  code?: ManagementErrorCode;
}

interface ExpectedRow {
  lastRunAt: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
}

function deriveExpectedRow(trace: readonly TraceEntry[]): ExpectedRow {
  // Precondition: trace is non-empty (asserted by the property's
  // `minLength: 1` arbitrary).
  const last = trace[trace.length - 1];

  let lastSuccessAt: number | null = null;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    if (trace[i].outcome === 'success') {
      lastSuccessAt = trace[i].ts;
      break;
    }
  }

  let lastError: string | null = null;
  let lastErrorAt: number | null = null;
  // Walk back from the end; if we hit a success before any failure,
  // the columns are NULL (recordSuccess wipes them). Otherwise the
  // first failure we encounter is the one persisted because each
  // subsequent failure overwrites `last_error` + `last_error_at`
  // and the success would have cleared them.
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    if (trace[i].outcome === 'success') {
      break;
    }
    lastError = trace[i].code ?? null;
    lastErrorAt = trace[i].ts;
    break;
  }

  let consecutiveFailures = 0;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    if (trace[i].outcome === 'success') {
      break;
    }
    consecutiveFailures += 1;
  }

  return {
    lastRunAt: last.ts,
    lastSuccessAt,
    lastError,
    lastErrorAt,
    consecutiveFailures,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const outcomeArb: fc.Arbitrary<Outcome> = fc.constantFrom<Outcome>(
  'success',
  'http_error',
  'network_error',
  'auth_error',
);

const stepArb = fc.record({
  outcome: outcomeArb,
  // `delta >= 1` keeps timestamps strictly monotonic, which makes
  // `last_run_at === ts of last call` a meaningful invariant (a delta
  // of 0 would let two calls share a wall-clock and collapse the
  // distinction between "newer" and "older" rows).
  delta: fc.integer({ min: 1, max: 10_000 }),
});

const traceArb = fc.array(stepArb, { minLength: 1, maxLength: 20 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)(
  'OpenClashManagementClient — Property 13 (network-quick-actions)',
  () => {
    it('collector_health.openclash.management counters track every call outcome', async () => {
      await fc.assert(
        fc.asyncProperty(traceArb, async (steps) => {
          // ---- Per-iteration setup ---------------------------------------
          const db = new Database(':memory:');
          db.pragma('foreign_keys = ON');
          runMigrations(db);
          const repos = createRepositories(db);

          // Compute the strictly-monotonic timestamp series the trace
          // will be evaluated against. The base is a fixed Unix-ms
          // anchor — the property does not depend on the absolute
          // value, only on relative ordering and equality with the
          // timestamps we feed into `now()`.
          const baseTs = 1_700_000_000_000;
          const timestamps: number[] = [];
          let cursor = baseTs;
          for (const s of steps) {
            cursor += s.delta;
            timestamps.push(cursor);
          }

          // Drive `now()` from a closed-over variable so each call
          // reads the timestamp of the step it is currently
          // executing. The management client stamps every
          // collector_health write with `now()`, so as long as we
          // hold `currentNow` stable across a single
          // readActiveConfigPath() invocation, the row's timestamp
          // columns will equal the step's `ts`.
          let currentNow = 0;

          const fakeFetchHandle = buildFakeFetch();

          const settings = buildSettings();
          const client = createOpenClashManagementClient({
            fetch: fakeFetchHandle.fetch,
            now: () => currentNow,
            secrets: fakeSecrets,
            collectorHealthRepo: repos.collectorHealth,
            // The read path never invokes the controller healthcheck;
            // a `false` stub keeps the closed-set error mapping
            // untouched.
            controllerHealthcheck: async () => false,
            getAppSettings: () => settings,
          });

          // ---- Drive the trace -------------------------------------------
          const trace: TraceEntry[] = [];
          for (let i = 0; i < steps.length; i += 1) {
            const outcome = steps[i].outcome;
            currentNow = timestamps[i];
            fakeFetchHandle.setOutcome(outcome);

            try {
              const result = await client.readActiveConfigPath();
              if (outcome !== 'success') {
                // The fake was programmed to fail but the call
                // resolved — this is a bug in the test plumbing or
                // the implementation. Record it so fast-check shrinks
                // to a counterexample and the assertion below fires.
                trace.push({ outcome, ts: timestamps[i], code: 'http_error' });
                db.close();
                throw new Error(
                  `unexpected resolve for outcome=${outcome}: ${result}`,
                );
              }
              trace.push({ outcome: 'success', ts: timestamps[i] });
            } catch (cause: unknown) {
              if (outcome === 'success') {
                db.close();
                throw cause;
              }
              // The management client throws a `ManagementError`
              // envelope (`{ code, message }`) on every failure path.
              const code =
                typeof cause === 'object' &&
                cause !== null &&
                'code' in cause &&
                typeof (cause as { code: unknown }).code === 'string'
                  ? ((cause as { code: ManagementErrorCode }).code)
                  : ('network_error' as ManagementErrorCode);
              trace.push({ outcome, ts: timestamps[i], code });
            }
          }

          // ---- Assertions ------------------------------------------------
          const expected = deriveExpectedRow(trace);
          const row = repos.collectorHealth.get(COLLECTOR_KEY);

          if (row === undefined) {
            db.close();
            return false;
          }

          // last_run_at: the timestamp of the latest call.
          if (row.lastRunAt !== expected.lastRunAt) {
            db.close();
            return false;
          }

          // last_success_at: the timestamp of the latest success
          // (or null when none).
          if (row.lastSuccessAt !== expected.lastSuccessAt) {
            db.close();
            return false;
          }

          // last_error_at: the timestamp of the most recent failure
          // (or null when none).
          if (row.lastErrorAt !== expected.lastErrorAt) {
            db.close();
            return false;
          }

          // last_error: the closed-set ManagementErrorCode of the
          // most recent failure (or null when none).
          if (row.lastError !== expected.lastError) {
            db.close();
            return false;
          }

          // consecutive_failures: count from the END of the trace.
          if (row.consecutiveFailures !== expected.consecutiveFailures) {
            db.close();
            return false;
          }

          // last_error must be a closed-set ManagementErrorCode
          // literal (Requirement 16.1). Defense-in-depth — covered
          // structurally by the implementation but asserted here so
          // a regression that widens the persisted error space is
          // caught at the property level.
          if (
            row.lastError !== null &&
            !CLOSED_ERROR_CODES.includes(row.lastError as ManagementErrorCode)
          ) {
            db.close();
            return false;
          }

          // last_error must not contain any body / Authorization
          // header / password substring (Requirement 14.5). The
          // implementation persists ONLY the closed-set literal, so
          // these substrings should never appear; we assert it here
          // so a future change that decides to append a tag string
          // (e.g. `"http_error: 500"`) cannot regress past these
          // sieves.
          if (row.lastError !== null) {
            const lower = row.lastError.toLowerCase();
            if (
              lower.includes('password') ||
              lower.includes('authorization') ||
              lower.includes('admin') ||
              lower.includes('sysauth')
            ) {
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

    it('sanity: a single-success trace populates only the success columns', async () => {
      // Example-based regression check that pins the success-side
      // wiring independently of the property — useful when a future
      // refactor accidentally swaps `recordSuccess` and
      // `recordFailure` (the property would still pass for an
      // all-success trace because both code paths look "successful"
      // from that angle).
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      const repos = createRepositories(db);

      const fakeFetchHandle = buildFakeFetch();
      fakeFetchHandle.setOutcome('success');

      const settings = buildSettings();
      const client = createOpenClashManagementClient({
        fetch: fakeFetchHandle.fetch,
        now: () => 1_700_000_000_000,
        secrets: fakeSecrets,
        collectorHealthRepo: repos.collectorHealth,
        controllerHealthcheck: async () => false,
        getAppSettings: () => settings,
      });

      const path = await client.readActiveConfigPath();
      expect(path).toBe('/etc/openclash/config/foo.yaml');

      const row = repos.collectorHealth.get(COLLECTOR_KEY);
      expect(row).toBeDefined();
      expect(row!.lastRunAt).toBe(1_700_000_000_000);
      expect(row!.lastSuccessAt).toBe(1_700_000_000_000);
      expect(row!.lastError).toBeNull();
      expect(row!.lastErrorAt).toBeNull();
      expect(row!.consecutiveFailures).toBe(0);

      db.close();
    });

    it('sanity: a single-failure trace populates only the failure columns', async () => {
      // Mirror of the success sanity test for the failure half.
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      const repos = createRepositories(db);

      const fakeFetchHandle = buildFakeFetch();
      fakeFetchHandle.setOutcome('http_error');

      const settings = buildSettings();
      const client = createOpenClashManagementClient({
        fetch: fakeFetchHandle.fetch,
        now: () => 1_700_000_001_000,
        secrets: fakeSecrets,
        collectorHealthRepo: repos.collectorHealth,
        controllerHealthcheck: async () => false,
        getAppSettings: () => settings,
      });

      await expect(client.readActiveConfigPath()).rejects.toMatchObject({
        code: 'http_error',
      });

      const row = repos.collectorHealth.get(COLLECTOR_KEY);
      expect(row).toBeDefined();
      expect(row!.lastRunAt).toBe(1_700_000_001_000);
      expect(row!.lastSuccessAt).toBeNull();
      expect(row!.lastError).toBe(OUTCOME_TO_CODE.http_error);
      expect(row!.lastErrorAt).toBe(1_700_000_001_000);
      expect(row!.consecutiveFailures).toBe(1);

      db.close();
    });
  },
);
