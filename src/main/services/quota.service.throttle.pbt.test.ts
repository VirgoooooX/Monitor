// Feature: cpa-quota-import, Property 4
//
// Property 4: per-account 5-minute throttle.
//
// Validates: Requirement 11.3, 17.3
//
// For any sequence of `refresh()` calls interleaved with non-negative
// clock advances, the in-memory aggregator MUST invoke each
// `(providerAuthId, endpoint)` adapter pair AT MOST
// `floor(totalAdvanceMs / REMOTE_THROTTLE_MS) + 1` times, where
// `REMOTE_THROTTLE_MS = 5 * 60 * 1000` and `totalAdvanceMs` is the
// sum of every clock advance issued during the run.
//
// Why this bound is tight:
//
//   The throttle gate inside `quota.service.ts` skips an adapter
//   call iff `now - cached.lastFetchedAt < REMOTE_THROTTLE_MS`. The
//   FIRST adapter call has no cache entry so it always goes through
//   and stamps `lastFetchedAt = now`. Subsequent calls require an
//   additional advance of at least `REMOTE_THROTTLE_MS` since the
//   previous successful adapter run. With monotonic clock, the
//   k-th successful adapter call stamps a time `t_k` satisfying
//   `t_k - t_{k-1} >= REMOTE_THROTTLE_MS`, so `t_n - t_1 >=
//   (n - 1) * REMOTE_THROTTLE_MS`. Since `t_n <= totalAdvanceMs`,
//   we get `n - 1 <= totalAdvanceMs / REMOTE_THROTTLE_MS`, i.e.
//   `n <= floor(totalAdvanceMs / REMOTE_THROTTLE_MS) + 1`.
//
//   In v1 every adapter owns one endpoint per provider, so the
//   `(providerAuthId, endpoint)` pair collapses to `providerAuthId`
//   for the purposes of this property — the counter is keyed by
//   `account.id` inside the stub adapter.
//
// Strategy:
//
//   * No I/O. The aggregator's collaborators are stubbed in-memory
//     (`SettingsRepository`, `ProviderAuthRepository`, `SecretsAdmin`)
//     and a single shared stub `ProviderAdapter` increments a
//     per-row call counter on every invocation.
//   * `now` is bound to a controllable closure clock — the harness
//     advances it by the generated `advanceMs` BEFORE each refresh
//     so the clock is strictly monotonic.
//   * Three refresh shapes are exercised: `refresh()` (full scope),
//     `refresh({ id })`, and `refresh({ provider })`. The bound is
//     scope-agnostic — the throttle is keyed by row, not by call
//     scope, so a `byId` refresh that hits nothing is just a no-op
//     and a `byProvider` refresh that hits multiple rows still gets
//     throttled per-row.
//   * `numRuns: 100` per the project's PBT contract.
//
// References:
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 11.3
//     (per-account 5-minute throttle on remote refresh)
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 17.3
//     (renderer never blocks on adapter I/O)
//   - .kiro/specs/cpa-quota-import/tasks.md §6.5
//   - src/main/services/quota.service.ts (`REMOTE_THROTTLE_MS`,
//     `runOneAccount`)

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createQuotaService } from './quota.service';
import type { ProviderId, QuotaSnapshot } from '../types';
import type {
  ProviderAuthRepository,
  ProviderAuthRow,
  SettingsRepository,
} from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';
import type { ProviderAdapter } from './quota/adapters';

// ---------------------------------------------------------------------------
// Constants — kept in lock-step with the production module.
// ---------------------------------------------------------------------------

const REMOTE_THROTTLE_MS = 5 * 60 * 1000;

const ALL_PROVIDERS: readonly ProviderId[] = [
  'claude-code',
  'codex',
  'gemini-cli',
  'antigravity',
  'gemini-api',
  'deepseek',
  'xiaomi',
  'openai-compatible',
];

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const PROVIDER_ID_ARB: fc.Arbitrary<ProviderId> = fc.constantFrom(
  ...ALL_PROVIDERS,
);

/**
 * Generate the (advance, refresh-shape, seed) tuple. The seed lets us
 * map `byId` / `byProvider` actions onto a row chosen at run-time
 * without coupling the action generator to the row-list generator.
 */
const STEP_ARB = fc.record({
  // 0..12 minutes — broad enough to span "no advance", "throttled",
  // and "well past throttle" in a single run while keeping the total
  // run time bounded.
  advanceMs: fc.integer({ min: 0, max: 12 * 60 * 1000 }),
  shape: fc.constantFrom('full', 'byId', 'byProvider' as const),
  // Used as `% rows.length` to pick a target row; bounded so shrinking
  // produces small readable counter-examples.
  seed: fc.integer({ min: 0, max: 31 }),
});

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function buildRow(id: string, provider: ProviderId): ProviderAuthRow {
  // Minimal, schema-compliant row. The aggregator only reads
  // `id` / `provider` / `label` / `accountId` / `projectId` /
  // `secretKey` / `lastQuotaAt` on the throttle path; the rest are
  // unused but populated so the row passes the `ProviderAuthMetadata`
  // structural type.
  return {
    id,
    provider,
    label: `${provider}:${id}`,
    source: 'cpa-auth-file',
    accountId: null,
    projectId: null,
    quotaCapability: 'official',
    importedAt: 0,
    updatedAt: 0,
    lastValidatedAt: null,
    lastQuotaAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    enabled: true,
    secretKey: `cpaAuth.providerAuth.${id}`,
  };
}

/**
 * In-memory `ProviderAuthRepository` — list / update only. The
 * service never calls `insert` / `remove` during a refresh; the
 * harness pre-seeds the repo with the generated rows.
 */
function createInMemoryRepo(
  rows: readonly ProviderAuthRow[],
): ProviderAuthRepository {
  const byId = new Map<string, ProviderAuthRow>();
  for (const r of rows) byId.set(r.id, { ...r });
  const sorted = (): ProviderAuthRow[] =>
    Array.from(byId.values()).sort((a, b) => a.importedAt - b.importedAt);
  return {
    list: () => sorted(),
    listByProvider: (provider) =>
      sorted().filter((r) => r.provider === provider),
    get: (id) => byId.get(id) ?? null,
    insert: (row) => {
      byId.set(row.id, { ...row });
    },
    update: (id, patch) => {
      const existing = byId.get(id);
      if (!existing) return;
      byId.set(id, { ...existing, ...patch });
    },
    remove: (id) => {
      byId.delete(id);
    },
  };
}

/** In-memory `SettingsRepository` for `quota.snapshots` persistence. */
function createInMemorySettings(): SettingsRepository {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      map.set(key, value);
    },
    remove(key: string): void {
      map.delete(key);
    },
    keys(): string[] {
      return Array.from(map.keys()).sort();
    },
    entries() {
      return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
    },
  };
}

/**
 * `SecretsAdmin` stub — Foundation-Phase placeholder adapters never
 * call `getSecret`, so any call that DID reach `secrets.get` would
 * indicate a misconfigured test, not a property violation. Returning
 * `null` would still be safe; we throw to make accidental coupling
 * loud during development.
 */
const NULL_SECRETS: SecretsAdmin = {
  set: () => {
    throw new Error('NULL_SECRETS.set should not be called by Property 4');
  },
  get: () => {
    throw new Error('NULL_SECRETS.get should not be called by Property 4');
  },
  remove: () => {
    throw new Error('NULL_SECRETS.remove should not be called by Property 4');
  },
};

/**
 * Build a counting stub adapter for `provider`. Every invocation
 * increments `callCounts.get(account.id)` and returns a synthetic
 * `unsupported` snapshot mirroring the Foundation-Phase placeholder
 * shape so the cache reconciliation in `quota.service` runs through
 * its happy path.
 */
function makeCountingAdapter(
  provider: ProviderId,
  callCounts: Map<string, number>,
): ProviderAdapter {
  return {
    provider,
    capability: 'official',
    refresh: async ({ account, now }) => {
      callCounts.set(account.id, (callCounts.get(account.id) ?? 0) + 1);
      const snapshot: QuotaSnapshot = {
        provider: account.provider,
        capturedAt: now,
        source: 'imported_auth',
        windows: [],
        providerAuthId: account.id,
        accountLabel: account.label,
        accountId: account.accountId,
        projectId: account.projectId,
        kind: 'quota',
        status: 'unsupported',
        rawPlanLabel: null,
        modelGroup: null,
        lastErrorCode: 'unsupported',
        lastErrorMessage: 'stub adapter',
      };
      return snapshot;
    },
  };
}

function buildAdapterRegistry(
  callCounts: Map<string, number>,
): Record<ProviderId, ProviderAdapter> {
  const entries = ALL_PROVIDERS.map(
    (p) => [p, makeCountingAdapter(p, callCounts)] as const,
  );
  return Object.fromEntries(entries) as Record<ProviderId, ProviderAdapter>;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('quota.service — Property 4 (cpa-quota-import)', () => {
  it('per-account adapter calls obey the 5-minute throttle bound', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 1..3 rows. Providers may repeat — the throttle is keyed by
        // `row.id`, not by provider, so two rows with the same
        // provider must throttle independently.
        fc.array(PROVIDER_ID_ARB, { minLength: 1, maxLength: 3 }),
        // 1..12 (advance, action) tuples. Upper bound keeps the
        // total wall time reasonable while still exploring schedules
        // that span multiple throttle windows.
        fc.array(STEP_ARB, { minLength: 1, maxLength: 12 }),
        async (providers, steps) => {
          const rows = providers.map((p, i) => buildRow(`row-${i}`, p));
          const callCounts = new Map<string, number>();
          for (const r of rows) callCounts.set(r.id, 0);

          // Controllable clock: closure-bound so `now()` is read at
          // call time (not at service-construction time).
          let clock = 0;
          const now = (): number => clock;

          const repo = createInMemoryRepo(rows);
          const settings = createInMemorySettings();
          const adapters = buildAdapterRegistry(callCounts);

          const service = createQuotaService({
            settings,
            providerAuth: repo,
            secrets: NULL_SECRETS,
            adapters,
            now,
          });

          let totalAdvanceMs = 0;
          for (const step of steps) {
            // Advance the clock BEFORE issuing the refresh — mirrors
            // wall-clock semantics where the user's next action
            // happens at a later instant than the previous response.
            clock += step.advanceMs;
            totalAdvanceMs += step.advanceMs;

            if (step.shape === 'full') {
              await service.refresh();
            } else if (step.shape === 'byId') {
              const target = rows[step.seed % rows.length]!;
              await service.refresh({ id: target.id });
            } else {
              const target = rows[step.seed % rows.length]!;
              await service.refresh({ provider: target.provider });
            }
          }

          // ------------------------------------------------------------
          // Throttle invariant — proven independently for each row.
          //
          // Bound: `floor(totalAdvanceMs / REMOTE_THROTTLE_MS) + 1`.
          // The "+1" covers the un-throttled first call (no prior
          // `lastFetchedAt`). Any row whose actual count exceeds this
          // bound is a counter-example.
          // ------------------------------------------------------------
          const maxCallsPerRow =
            Math.floor(totalAdvanceMs / REMOTE_THROTTLE_MS) + 1;
          for (const row of rows) {
            const calls = callCounts.get(row.id) ?? 0;
            expect(calls).toBeLessThanOrEqual(maxCallsPerRow);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
