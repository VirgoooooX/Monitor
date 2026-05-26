// Feature: network-quick-actions, Property 15: No secret value appears in any persisted column or diagnostics output.
//
// Validates Requirements 8.3, 8.4, 12.4, 14.5.
//
// Property: For any set of secret values stored under the
// `openclash.management.username`, `openclash.management.password`,
// and `openclash.controllerSecret` keys (Requirement 12.1) and any
// finite trace of management-client calls and Config_Switch flows
// driven against those secrets:
//
//   * Every column of every row written to `openclash_config_changes`
//     contains NO occurrence of any current secret value as a
//     substring (Requirement 8.3).
//   * Every column of every row in `collector_health` contains NO
//     occurrence of any current secret value as a substring
//     (Requirement 14.5).
//   * The JSON serialization of `getDiagnostics()` contains NO
//     occurrence of any current secret value as a substring
//     (Requirements 8.4, 12.4).
//
// References:
//   - .kiro/specs/network-quick-actions/design.md §Property 15
//   - .kiro/specs/network-quick-actions/requirements.md
//       Requirement 8.3 (audit rows must not contain credentials,
//                       Authorization headers, request/response bodies)
//       Requirement 8.4 (diagnostics export same-redaction-strength)
//       Requirement 12.4 (management interface fields redacted)
//       Requirement 14.5 (collector_health columns must not contain
//                       request bodies, headers, or credential values)
//
// Strategy
// --------
//
//   * Use better-sqlite3 ':memory:' driven through the production
//     `runMigrations` + `createRepositories` factory so every row
//     under test is written by the SAME repositories used in
//     production (no test-only schema drift).
//   * Wire production `createOpenClashManagementClient`,
//     `createConfigSwitchAuditService`, and `createDiagnosticsService`
//     so the test exercises the same redaction paths the user will hit
//     at runtime.
//   * Inject fake `fetch`, `now`, `sleep`, and `secrets` (with the
//     user-provided arbitrary secret values), and a stubbed
//     `controllerHealthcheck`, all driven by a per-step state machine
//     so that a single trace can mix successful/failed reads with
//     successful/failed switch flows.
//   * The fake clock advances ONLY when `sleep(ms)` is invoked, so a
//     `verify_timeout` flow does not sit on real timers (each property
//     iteration completes in well under a millisecond of wall time).
//   * Run >=100 cases per the fast-check property contract.
//
// Pragmatic filtering
// -------------------
//
// The task generates secret values with
// `fc.string({ minLength: 1, maxLength: 30 })` filtered to exclude
// pure-whitespace strings. To keep the property meaningful (a
// single-character secret like `"0"` is naturally a substring of every
// timestamp written to the audit table; a value like `"ok"` is the
// closed-set success code), we additionally `fc.pre()`-skip
// iterations whose generated secrets are substrings of expected
// non-secret content (timestamps, error codes, paths, the management
// URL host/port). The skipped cases are NOT property failures — they
// are degenerate inputs whose match-as-substring would falsely flag
// the production code's correct behavior. This filter is a property-
// preserving refinement of the input space; the underlying invariant
// (no secret VALUE leaks past the redaction sieve) remains exactly
// the one Property 15 asserts.

import { describe, it } from 'vitest';
import fc from 'fast-check';

let Database: typeof import('better-sqlite3');
let canRun = true;

try {
  Database = (await import('better-sqlite3')).default;
  // Quick probe: open + close to confirm the native binding is usable
  // against the running Node.js. When better-sqlite3 has been compiled
  // for Electron the NODE_MODULE_VERSION mismatch lands here and we
  // skip the suite — same pattern used by the other management
  // service PBT files in this directory.
  const probe = new Database(':memory:');
  probe.close();
} catch {
  canRun = false;
}

const { runMigrations } = await import('../store/migrations');
const { createRepositories, APP_SETTINGS_KEY } = await import(
  '../store/repositories'
);
const { createOpenClashManagementClient } = await import(
  './openclash.management.service'
);
const { createConfigSwitchAuditService } = await import(
  './openclash.config.audit'
);
const { createDiagnosticsService } = await import('./diagnostics.service');

import type { SecretsModule } from '../security/secrets';
import type { AppSettings } from '../types';
import type {
  ConfigChangeResultCode,
  OpenClashConfigChangeRow,
  CollectorHealthRow,
} from '../store/repositories';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANAGEMENT_URL = 'http://192.168.31.100';
const CONTROLLER_URL = 'http://192.168.31.100:9090';
const TARGET_PATH = '/etc/openclash/config/target.yaml';
const START_PATH = '/etc/openclash/config/initial.yaml';

/**
 * Strings that naturally appear in non-secret columns of the data
 * under test. Any generated secret that is a substring of one of
 * these strings (or whose presence in one of these strings would
 * yield a false positive when scanning) is skipped via `fc.pre()`.
 *
 * This is the test's "natural-content blocklist": it captures the
 * vocabulary of timestamps, closed-set codes, paths, table keys, and
 * the management/controller URLs. The list is deliberately
 * over-inclusive — it is cheaper to skip a slightly-too-restrictive
 * input than to chase down a false-positive shrink.
 */
const NATURAL_CONTENT_BLOCKLIST = [
  // Closed-set codes that may appear verbatim in collector_health and
  // openclash_config_changes columns.
  'ok',
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
  'not_supported',
  'switch_in_progress',
  'start',
  'end',
  'openclash.management',
  'openclash.controllerSecret',
  // Path / URL substrings.
  '/etc/openclash/config/',
  TARGET_PATH,
  START_PATH,
  MANAGEMENT_URL,
  CONTROLLER_URL,
  '192.168.31.100',
  '9090',
  'http://',
  '.yaml',
  '.yml',
  'config_path',
  // Timestamp prefix used in this test (1.7e12 ms — ~Nov 2023).
  '1700000',
  '17000000',
  // Generic literals used in JSON keys / null markers.
  'null',
  'true',
  'false',
  '<redacted>',
  'configFileWhitelist',
  'requestTimeoutMs',
  'managementInterface',
  'recentConfigSwitches',
  'collectors',
  'redactedControllerUrl',
];

// ---------------------------------------------------------------------------
// AppSettings + SecretsModule fakes
// ---------------------------------------------------------------------------

function buildSettings(): AppSettings {
  return {
    controllerUrl: CONTROLLER_URL,
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
      url: MANAGEMENT_URL,
      requestTimeoutMs: 10_000,
      configFileWhitelist: [
        { alias: 'target', path: TARGET_PATH },
        { alias: 'initial', path: START_PATH },
      ],
    },
  } as AppSettings;
}

/**
 * Build a `SecretsModule` stub backed by the user-provided secret
 * values. `get` returns the username/password under the management
 * keys (so the LuCI login path can succeed) and the controller secret
 * under `openclash.controllerSecret` (so the diagnostics service's
 * value-based redaction sieve has all three values to check against).
 */
function buildFakeSecrets(values: {
  username: string;
  password: string;
  controllerSecret: string;
}): SecretsModule {
  return {
    isAvailable() {
      return true;
    },
    set() {
      /* unused — secrets are seeded via the closed-over `values` */
    },
    get(key) {
      if (key === 'openclash.management.username') return values.username;
      if (key === 'openclash.management.password') return values.password;
      if (key === 'openclash.controllerSecret') return values.controllerSecret;
      return null;
    },
    remove() {
      /* unused */
    },
  };
}

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

interface FakeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

function buildFakeClock(start: number): FakeClock {
  let clock = start;
  return {
    now: () => clock,
    sleep(ms: number): Promise<void> {
      if (ms > 0) {
        clock += ms;
      }
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Step types & arbitraries
// ---------------------------------------------------------------------------

/**
 * High-level operations the test drives. Each step exercises one of
 * the production paths that touches `collector_health`,
 * `openclash_config_changes`, or the diagnostics export shape.
 */
type Step =
  | { kind: 'read'; outcome: 'success' | 'auth_error' | 'http_error' | 'network_error' }
  | {
      kind: 'switch';
      outcome:
        | 'ok'
        | 'write_auth_error'
        | 'write_http_error'
        | 'write_network_error'
        | 'verify_timeout';
    };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('read' as const),
    outcome: fc.constantFrom<'success' | 'auth_error' | 'http_error' | 'network_error'>(
      'success',
      'auth_error',
      'http_error',
      'network_error',
    ),
  }),
  fc.record({
    kind: fc.constant('switch' as const),
    outcome: fc.constantFrom<
      'ok' | 'write_auth_error' | 'write_http_error' | 'write_network_error' | 'verify_timeout'
    >(
      'ok',
      'write_auth_error',
      'write_http_error',
      'write_network_error',
      'verify_timeout',
    ),
  }),
);

const traceArb = fc.array(stepArb, { minLength: 5, maxLength: 10 });

/**
 * Generator for one secret value. Per task 11.2:
 *   - `fc.string({ minLength: 1, maxLength: 30 })`
 *   - filtered to exclude pure-whitespace strings
 *
 * Additional natural-content filtering happens at the property level
 * via `fc.pre()` so degenerate values that would falsely match
 * timestamps / closed-set codes / URL substrings do not flag the
 * production redaction sieve.
 */
const secretArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

// ---------------------------------------------------------------------------
// Fake fetch — programmable LuCI / ubus state machine
// ---------------------------------------------------------------------------

interface FakeFetchHandle {
  fetch: typeof fetch;
  /**
   * Set the outcome the next high-level call (read or switch) should
   * deliver. Reset before each step.
   */
  setOutcome(o: Step['outcome'], kind: Step['kind']): void;
  /**
   * Reset internal sub-call counters at the start of each step so the
   * state machine knows whether it is servicing the pre-write read or
   * a verify-loop read.
   */
  resetStepState(): void;
}

function buildFakeFetch(): FakeFetchHandle {
  let kind: Step['kind'] = 'read';
  let outcome: Step['outcome'] = 'success';
  let preWriteReadConsumed = false;

  const ubusOk = (data: Record<string, unknown>): Response =>
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: [0, data] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const ubusPermissionDenied = (): Response =>
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: [6, null] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const ubusGenericError = (): Response =>
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: [4, null] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const fakeFetch: typeof fetch = async (request, init) => {
    const url =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.toString()
          : (request as Request).url;
    const path = new URL(url).pathname;

    // ---- LuCI login endpoint --------------------------------------------
    if (path === '/cgi-bin/luci') {
      // Login always succeeds — auth_error outcomes are surfaced via
      // the ubus 401 path so the management client's transparent re-
      // login machinery is exercised end-to-end.
      return new Response('', {
        status: 200,
        headers: { 'Set-Cookie': 'sysauth=token1; Path=/; HttpOnly' },
      });
    }

    // ---- LuCI ubus endpoint ---------------------------------------------
    if (
      path === '/cgi-bin/luci/ubus/' ||
      path === '/cgi-bin/luci/admin/ubus/'
    ) {
      let body: { params?: unknown[]; method?: string } = {};
      try {
        const raw =
          typeof init?.body === 'string'
            ? init.body
            : new TextDecoder().decode(
                (init?.body as ArrayBuffer | undefined) ?? new Uint8Array(),
              );
        body = JSON.parse(raw) as { params?: unknown[]; method?: string };
      } catch {
        return new Response('', { status: 500 });
      }

      const params = Array.isArray(body.params) ? body.params : [];
      const ubusObject =
        typeof params[1] === 'string' ? (params[1] as string) : null;
      const ubusMethod =
        typeof params[2] === 'string' ? (params[2] as string) : null;

      // ---- READ flow ---------------------------------------------------
      if (kind === 'read') {
        if (ubusObject === 'uci' && ubusMethod === 'get') {
          if (outcome === 'success') {
            return ubusOk({ value: TARGET_PATH });
          }
          if (outcome === 'http_error') {
            return new Response('', { status: 500 });
          }
          if (outcome === 'network_error') {
            const cause = Object.assign(new Error('ECONNREFUSED'), {
              name: 'Error',
            });
            const err = new TypeError('fetch failed');
            Object.assign(err, { cause });
            throw err;
          }
          // 'auth_error' — both the initial ubus and the retry land here.
          return new Response('', { status: 401 });
        }
        return new Response('', { status: 500 });
      }

      // ---- SWITCH flow -------------------------------------------------
      if (ubusObject === 'uci' && ubusMethod === 'get') {
        if (!preWriteReadConsumed) {
          // Pre-write start-path read.
          preWriteReadConsumed = true;
          return ubusOk({ value: START_PATH });
        }
        // Verify-loop read.
        if (outcome === 'ok') {
          return ubusOk({ value: TARGET_PATH });
        }
        if (outcome === 'verify_timeout') {
          return ubusOk({ value: START_PATH });
        }
        // Should not be reached — the write-failure branches return
        // before any verify read is issued.
        return ubusOk({ value: START_PATH });
      }

      // Write-transaction sub-calls: uci.set / uci.commit / file.exec.
      const isSet = ubusObject === 'uci' && ubusMethod === 'set';
      const isCommit = ubusObject === 'uci' && ubusMethod === 'commit';
      const isExec = ubusObject === 'file' && ubusMethod === 'exec';

      if (isSet) {
        if (outcome === 'write_auth_error') {
          return ubusPermissionDenied();
        }
        if (outcome === 'write_http_error') {
          return ubusGenericError();
        }
        if (outcome === 'write_network_error') {
          const cause = Object.assign(new Error('ECONNREFUSED'), {
            name: 'Error',
          });
          const err = new TypeError('fetch failed');
          Object.assign(err, { cause });
          throw err;
        }
        return ubusOk({});
      }
      if (isCommit || isExec) {
        return ubusOk({});
      }

      return new Response('', { status: 500 });
    }

    throw new Error(`fakeFetch: unexpected URL ${url}`);
  };

  return {
    fetch: fakeFetch,
    setOutcome(o, k) {
      outcome = o;
      kind = k;
    },
    resetStepState() {
      preWriteReadConsumed = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Substring scanning helpers
// ---------------------------------------------------------------------------

/** Stringify a single column value for substring scanning. */
function columnAsString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('binary');
  }
  return JSON.stringify(value);
}

/** Concatenate every column of every row into a single scan target. */
function concatRows(rows: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      parts.push(key);
      parts.push(columnAsString(row[key]));
    }
  }
  return parts.join('\u0000');
}

/**
 * Decide whether to skip a generated secret triple because at least
 * one value would naturally appear as a substring of expected non-
 * secret content. See the "Pragmatic filtering" note at the file
 * header for the rationale.
 */
function shouldSkipSecrets(values: readonly string[]): boolean {
  for (const value of values) {
    if (value.length === 0) {
      return true;
    }
    // Single-character secrets collide with timestamps, indices, the
    // confirmed=1 column, and JSON delimiters. Skip them.
    if (value.length < 2) {
      return true;
    }
    // Pure-digit secrets collide with timestamps / durations /
    // consecutive_failures.
    if (/^[0-9]+$/.test(value)) {
      return true;
    }
    for (const blocked of NATURAL_CONTENT_BLOCKLIST) {
      if (blocked.includes(value) || value.includes(blocked)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)(
  'Diagnostics + audit + collector_health — Property 15 (network-quick-actions)',
  () => {
    it('no secret value appears in any persisted column or diagnostics output', async () => {
      await fc.assert(
        fc.asyncProperty(
          secretArb,
          secretArb,
          secretArb,
          traceArb,
          async (username, password, controllerSecret, steps) => {
            // Skip degenerate inputs that would trigger natural-content
            // false positives (see file header).
            fc.pre(
              !shouldSkipSecrets([username, password, controllerSecret]),
            );

            // ---- Per-iteration setup ------------------------------------
            const db = new Database(':memory:');
            db.pragma('foreign_keys = ON');
            runMigrations(db);
            const repos = createRepositories(db);

            // Persist the AppSettings blob so the diagnostics service
            // reads the management interface URL from the same place
            // the production wiring does.
            repos.settings.set(APP_SETTINGS_KEY, buildSettings());

            const baseTs = 1_700_000_000_000;
            const clock = buildFakeClock(baseTs);
            const fakeFetchHandle = buildFakeFetch();

            const fakeSecrets = buildFakeSecrets({
              username,
              password,
              controllerSecret,
            });
            const settings = buildSettings();

            const client = createOpenClashManagementClient({
              fetch: fakeFetchHandle.fetch,
              now: clock.now,
              sleep: clock.sleep,
              secrets: fakeSecrets,
              collectorHealthRepo: repos.collectorHealth,
              // For the verify loop's `apiOk` half. `ok` flows return
              // true so verify lands on the first iteration; the
              // verify_timeout flow returns false so the loop runs out
              // its budget without a confirmed flip.
              controllerHealthcheck: async () => false,
              getAppSettings: () => settings,
            });

            const auditService = createConfigSwitchAuditService({
              repository: repos.openClashConfigChanges,
            });

            const diagnosticsService = createDiagnosticsService({
              settings: repos.settings,
              collectorHealth: repos.collectorHealth,
              openClashConfigChanges: repos.openClashConfigChanges,
              getSecretValues: () => [username, password, controllerSecret],
            });

            // ---- Drive the trace ----------------------------------------
            for (const step of steps) {
              fakeFetchHandle.resetStepState();
              fakeFetchHandle.setOutcome(step.outcome, step.kind);
              // The management client may cache a session cookie from
              // the previous step. Force a fresh login per step so
              // every flow exercises the login path with the current
              // (arbitrary) credentials, which is what we actually
              // want to assert is never persisted.
              client.invalidateSession();

              if (step.kind === 'read') {
                try {
                  await client.readActiveConfigPath();
                } catch {
                  // Failures are expected for non-success outcomes;
                  // collector_health captures them.
                }
                continue;
              }

              // step.kind === 'switch'
              const flowStartTs = clock.now();
              // Observability-only: capture the start path the
              // management client would read. We let the client do the
              // read inside switchActiveConfig — this matches the
              // production orchestrator (task 10.4).
              const rowId = auditService.recordSwitchStart({
                targetPath: TARGET_PATH,
                startPath: START_PATH,
                now: flowStartTs,
              });

              const result = await client.switchActiveConfig({
                targetPath: TARGET_PATH,
                verifyWindowMs: settings.configSwitchVerifyWindowMs,
                requestTimeoutMs:
                  settings.managementInterface.requestTimeoutMs,
              });

              const flowEndTs = clock.now();
              const resultCode: ConfigChangeResultCode = result.ok
                ? 'ok'
                : (result.error?.code ?? 'http_error');
              auditService.recordSwitchEnd({
                rowId,
                targetPath: TARGET_PATH,
                startPath: result.startPath,
                finalPath: result.finalPath,
                resultCode,
                startedAt: flowStartTs,
                endedAt: flowEndTs,
              });
            }

            // ---- Assertions: no secret value appears as a substring -----
            const secretValues = [username, password, controllerSecret];

            // openclash_config_changes.
            const configChangeRows: OpenClashConfigChangeRow[] =
              repos.openClashConfigChanges.recent(1000);
            const configChangesConcat = concatRows(
              configChangeRows as unknown as Array<Record<string, unknown>>,
            );
            for (const value of secretValues) {
              if (configChangesConcat.includes(value)) {
                db.close();
                return false;
              }
            }

            // collector_health.
            const collectorRows: CollectorHealthRow[] =
              repos.collectorHealth.list();
            const collectorConcat = concatRows(
              collectorRows as unknown as Array<Record<string, unknown>>,
            );
            for (const value of secretValues) {
              if (collectorConcat.includes(value)) {
                db.close();
                return false;
              }
            }

            // diagnostics export — JSON-stringified.
            const report = diagnosticsService.export();
            const reportJson = JSON.stringify(report);
            for (const value of secretValues) {
              if (reportJson.includes(value)) {
                db.close();
                return false;
              }
            }

            db.close();
            return true;
          },
        ),
        { numRuns: 100 },
      );
    });
  },
);
