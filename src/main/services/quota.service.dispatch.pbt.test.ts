// Feature: cpa-quota-import, Property 3
//
// Property 3: per-account dispatch + stale retention.
//
// Validates: Requirement 11.1, 11.2
//
// For any list of `provider_auth` rows mixed with adapter behaviours
// (success / reject / unsupported), after a sequence of `refresh()`
// calls the in-memory aggregator MUST satisfy:
//
//   (a) Every row has a corresponding cache entry keyed by
//       `providerAuthId`.
//   (b) The cache size is exactly `rows.length` (+1 when the Codex
//       local-log fallback is in scope, i.e. `parseCodexLocalRateLimits`
//       is supplied AND no `codex` row exists).
//   (c) For any row whose LATEST adapter result was a rejection AND
//       which had a prior successful snapshot, the cache entry MUST
//       carry `status='stale'` and preserve the windows / kind /
//       rawPlanLabel / modelGroup of the previous success
//       (Requirement 6.4 + 11.2 — `quota.service.ts#markStale`).
//
// Why these invariants together exercise per-account dispatch:
//
//   `quota.service.ts#refresh` enumerates every target row and
//   dispatches each via `Promise.allSettled` so a single rejection
//   cannot poison the others. (a) + (b) prove the dispatcher
//   considered every row exactly once per cycle (no skips, no
//   duplicates beyond the documented Codex sentinel). (c) proves the
//   stale-retention contract: a failed refresh keeps the previous
//   value visible in the cache, only flipping `status`/`lastError*`,
//   instead of dropping the row or replacing it with empty data.
//
// Strategy:
//
//   * No I/O. The aggregator's collaborators are stubbed in-memory
//     (`SettingsRepository`, `ProviderAuthRepository`, `SecretsAdmin`)
//     and a single shared stub `ProviderAdapter` per provider reads
//     a per-row behaviour from a closure-bound map that the harness
//     re-populates between rounds.
//   * Distinctive success markers (`rawPlanLabel`, `modelGroup`,
//     `windows[0].name`) embed the round index + row id so the
//     stale-retention check can identify exactly which prior
//     success the cache preserved.
//   * `now()` is a controllable closure clock advanced by
//     `REMOTE_THROTTLE_MS + 1` between rounds so the per-account
//     throttle never short-circuits an adapter call (the throttle
//     itself is exercised by Property 4).
//   * `numRuns: 100` per the project's PBT contract.
//
// References:
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 11.1
//     (per-account dispatch via `Promise.allSettled`)
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 11.2
//     (stale retention of last successful snapshot on failure)
//   - .kiro/specs/cpa-quota-import/tasks.md §6.4
//   - src/main/services/quota.service.ts (`refresh`, `markStale`,
//     `runOneAccount`, Codex fallback path)

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

const MAX_ROWS = 5;
const MAX_ROUNDS = 5;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const PROVIDER_ID_ARB: fc.Arbitrary<ProviderId> = fc.constantFrom(
  ...ALL_PROVIDERS,
);

type Behavior = 'success' | 'reject' | 'unsupported';

const BEHAVIOR_ARB: fc.Arbitrary<Behavior> = fc.constantFrom(
  'success',
  'reject',
  'unsupported',
);

// ---------------------------------------------------------------------------
// Test doubles — copied from `quota.service.throttle.pbt.test.ts` for
// parity with task 6.3's in-memory stubs (per task 6.4 instructions).
// ---------------------------------------------------------------------------

function buildRow(id: string, provider: ProviderId): ProviderAuthRow {
  // Minimal, schema-compliant row. The aggregator only reads
  // `id` / `provider` / `label` / `accountId` / `projectId` /
  // `secretKey` / `lastQuotaAt` on the dispatch path; the rest are
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
 * In-memory `ProviderAuthRepository`. The service never calls
 * `insert` / `remove` during a refresh; the harness pre-seeds the
 * repo with the generated rows. `update` is stubbed so the
 * aggregator's `repo.update(...)` calls (last_quota_at,
 * last_error_*) do not throw.
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
 * call `getSecret`, and the stub adapters in this property do not
 * either. Throwing makes accidental coupling loud during dev.
 */
const NULL_SECRETS: SecretsAdmin = {
  set: () => {
    throw new Error('NULL_SECRETS.set should not be called by Property 3');
  },
  get: () => {
    throw new Error('NULL_SECRETS.get should not be called by Property 3');
  },
  remove: () => {
    throw new Error('NULL_SECRETS.remove should not be called by Property 3');
  },
};

// ---------------------------------------------------------------------------
// Adapter factory — closure over the harness state so each refresh
// round can swap behaviours without rebuilding the registry.
// ---------------------------------------------------------------------------

interface AdapterContext {
  /** Behaviour to apply for the next adapter call, keyed by row id. */
  readonly behaviorByRow: Map<string, Behavior>;
  /** Current round index — embedded in success markers. */
  roundIdx: number;
}

function makeBehaviorAdapter(
  provider: ProviderId,
  ctx: AdapterContext,
): ProviderAdapter {
  return {
    provider,
    capability: 'official',
    refresh: async ({ account, now }) => {
      const behavior = ctx.behaviorByRow.get(account.id) ?? 'unsupported';
      if (behavior === 'reject') {
        // Throwing surfaces as `Promise.allSettled` rejection inside
        // the service; `markStale` then preserves the previous
        // snapshot.
        throw new Error(`adapter rejected at round ${ctx.roundIdx}`);
      }
      if (behavior === 'unsupported') {
        return {
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
          lastErrorMessage: 'unsupported placeholder',
        };
      }
      // success — distinctive markers tied to (round, row) so the
      // stale-retention check can identify exactly which prior
      // success the cache preserved.
      return {
        provider: account.provider,
        capturedAt: now,
        source: 'imported_auth',
        windows: [
          {
            name: `r${ctx.roundIdx}-${account.id}`,
            percentLeft: 75,
            resetAt: null,
            windowSeconds: 18000,
          },
        ],
        providerAuthId: account.id,
        accountLabel: account.label,
        accountId: account.accountId,
        projectId: account.projectId,
        kind: 'quota',
        status: 'ok',
        rawPlanLabel: `plan-r${ctx.roundIdx}-${account.id}`,
        modelGroup: `mg-r${ctx.roundIdx}-${account.id}`,
        lastErrorCode: null,
        lastErrorMessage: null,
      };
    },
  };
}

function buildAdapterRegistry(
  ctx: AdapterContext,
): Record<ProviderId, ProviderAdapter> {
  const entries = ALL_PROVIDERS.map(
    (p) => [p, makeBehaviorAdapter(p, ctx)] as const,
  );
  return Object.fromEntries(entries) as Record<ProviderId, ProviderAdapter>;
}

/**
 * Build the expected snapshot a `success` adapter call would have
 * produced at `(roundIdx, row)`. Mirrors the adapter body above so
 * the property can compare cached stale snapshots against the
 * expected previous-success markers without reading the cache twice.
 */
function expectedSuccessSnapshot(
  row: ProviderAuthRow,
  roundIdx: number,
  capturedAt: number,
): QuotaSnapshot {
  return {
    provider: row.provider,
    capturedAt,
    source: 'imported_auth',
    windows: [
      {
        name: `r${roundIdx}-${row.id}`,
        percentLeft: 75,
        resetAt: null,
        windowSeconds: 18000,
      },
    ],
    providerAuthId: row.id,
    accountLabel: row.label,
    accountId: row.accountId,
    projectId: row.projectId,
    kind: 'quota',
    status: 'ok',
    rawPlanLabel: `plan-r${roundIdx}-${row.id}`,
    modelGroup: `mg-r${roundIdx}-${row.id}`,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('quota.service — Property 3 (cpa-quota-import)', () => {
  it('per-account dispatch covers every row and preserves stale snapshots after rejection', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 1..MAX_ROWS rows. Providers may repeat — two rows on the
        // same provider must dispatch independently.
        fc.array(PROVIDER_ID_ARB, { minLength: 1, maxLength: MAX_ROWS }),
        // 1..MAX_ROUNDS rounds; each round carries exactly MAX_ROWS
        // behaviours so the harness can index `rounds[r][i]` for any
        // row count up to MAX_ROWS without bounds-juggling.
        fc.array(
          fc.array(BEHAVIOR_ARB, {
            minLength: MAX_ROWS,
            maxLength: MAX_ROWS,
          }),
          { minLength: 1, maxLength: MAX_ROUNDS },
        ),
        // Whether to wire the Codex local-log fallback. When `true`
        // AND no `codex` row is present, the service should add a
        // `__codex_local__` cache entry, growing the cache size by
        // exactly one (Requirement 11.6).
        fc.boolean(),
        async (providers, rounds, includeCodexFallback) => {
          const numRows = providers.length;
          const numRounds = rounds.length;

          const rows = providers.map((p, i) => buildRow(`row-${i}`, p));

          // Adapter context: behaviours mutate per round, round index
          // gets embedded in success markers.
          const ctx: AdapterContext = {
            behaviorByRow: new Map<string, Behavior>(),
            roundIdx: 0,
          };

          // Controllable clock — advanced by `REMOTE_THROTTLE_MS + 1`
          // between rounds so the per-account throttle never elides
          // an adapter call.
          let clock = 1_000_000;
          const now = (): number => clock;

          // Codex fallback stub: returns a fresh `local_log` snapshot
          // on every call so the `__codex_local__` cache entry shows
          // up deterministically when the fallback is in scope.
          const codexFallback = async (): Promise<QuotaSnapshot> => ({
            provider: 'codex',
            capturedAt: clock,
            source: 'local_log',
            windows: [],
            providerAuthId: null,
            accountLabel: null,
            accountId: null,
            projectId: null,
            kind: 'quota',
            status: 'ok',
            rawPlanLabel: null,
            modelGroup: null,
            lastErrorCode: null,
            lastErrorMessage: null,
          });

          const repo = createInMemoryRepo(rows);
          const settings = createInMemorySettings();
          const adapters = buildAdapterRegistry(ctx);

          const service = createQuotaService({
            settings,
            providerAuth: repo,
            secrets: NULL_SECRETS,
            adapters,
            ...(includeCodexFallback
              ? { parseCodexLocalRateLimits: codexFallback }
              : {}),
            now,
          });

          // Track the most recent SUCCESS snapshot per row so the
          // stale-retention assertion can compare cached `status='stale'`
          // entries against the exact previous success.
          const lastSuccessByRow = new Map<string, QuotaSnapshot>();

          for (let r = 0; r < numRounds; r++) {
            ctx.roundIdx = r;

            // Advance clock so every row is throttle-eligible. The
            // first round still goes through unconditionally because
            // there is no cached `lastFetchedAt`.
            clock += REMOTE_THROTTLE_MS + 1;

            // Apply this round's behaviours to the closure map.
            ctx.behaviorByRow.clear();
            for (let i = 0; i < numRows; i++) {
              ctx.behaviorByRow.set(rows[i]!.id, rounds[r]![i]!);
            }

            // Track expected success snapshots BEFORE the call so
            // the captured `clock` matches the adapter's `now`.
            const capturedAt = clock;

            await service.refresh();

            // Update the per-row last-success record using the
            // captured timestamp so a later stale entry's preserved
            // markers can be compared exactly.
            for (let i = 0; i < numRows; i++) {
              const beh = rounds[r]![i]!;
              if (beh === 'success') {
                lastSuccessByRow.set(
                  rows[i]!.id,
                  expectedSuccessSnapshot(rows[i]!, r, capturedAt),
                );
              }
            }
          }

          // ------------------------------------------------------------
          // Read the final cache via `getQuotaStatus`. Note: this hot
          // path may fire a background refresh when the oldest entry
          // is older than `REMOTE_THROTTLE_MS`, but the current run
          // just stamped every entry with `lastFetchedAt = clock`, so
          // no background refresh is triggered before we read.
          // ------------------------------------------------------------
          const status = await service.getQuotaStatus();

          // Build a lookup by `providerAuthId`. The Codex fallback
          // sentinel has `providerAuthId === null` and is counted
          // separately.
          const cacheById = new Map<string, QuotaSnapshot>();
          let codexFallbackEntries = 0;
          for (const s of status.snapshots) {
            if (s.providerAuthId === null) {
              codexFallbackEntries += 1;
            } else {
              cacheById.set(s.providerAuthId, s);
            }
          }

          // ------------------------------------------------------------
          // Invariant (a) — every row has a cache entry.
          // ------------------------------------------------------------
          for (const row of rows) {
            expect(cacheById.has(row.id)).toBe(true);
          }

          // ------------------------------------------------------------
          // Invariant (b) — cache size = rows.length (+1 when Codex
          // fallback is in scope and no `codex` row exists).
          // ------------------------------------------------------------
          const codexInRows = rows.some((r) => r.provider === 'codex');
          const expectedFallback = includeCodexFallback && !codexInRows;
          const expectedCacheSize = rows.length + (expectedFallback ? 1 : 0);
          expect(status.snapshots.length).toBe(expectedCacheSize);
          expect(codexFallbackEntries).toBe(expectedFallback ? 1 : 0);

          // ------------------------------------------------------------
          // Invariant (c) — for any row whose latest behaviour was a
          // rejection AND which had a prior successful snapshot, the
          // cached entry preserves the previous success's content
          // (windows / kind / rawPlanLabel / modelGroup / source /
          // accountLabel / accountId / projectId) and only flips
          // `status` to `'stale'` plus updates `lastError*` and
          // `capturedAt`.
          // ------------------------------------------------------------
          for (let i = 0; i < numRows; i++) {
            const row = rows[i]!;
            const lastBehavior = rounds[numRounds - 1]![i]!;
            const cached = cacheById.get(row.id)!;

            if (lastBehavior === 'reject') {
              expect(cached.status).toBe('stale');
              const prev = lastSuccessByRow.get(row.id);
              if (prev !== undefined) {
                // Preserved fields from the prior success.
                expect(cached.windows).toEqual(prev.windows);
                expect(cached.kind).toBe(prev.kind);
                expect(cached.rawPlanLabel).toBe(prev.rawPlanLabel);
                expect(cached.modelGroup).toBe(prev.modelGroup);
                expect(cached.source).toBe(prev.source);
                expect(cached.accountLabel).toBe(prev.accountLabel);
                expect(cached.accountId).toBe(prev.accountId);
                expect(cached.projectId).toBe(prev.projectId);
                expect(cached.providerAuthId).toBe(prev.providerAuthId);
                expect(cached.provider).toBe(prev.provider);
                // The error path must surface a non-null error code
                // and a bounded message so the renderer can show it.
                expect(cached.lastErrorCode).not.toBeNull();
                expect(cached.lastErrorMessage).not.toBeNull();
                if (cached.lastErrorMessage !== null) {
                  expect(
                    cached.lastErrorMessage.length,
                  ).toBeLessThanOrEqual(80);
                }
              }
            } else if (lastBehavior === 'success') {
              // Sanity check: a successful latest call must not be
              // marked stale.
              expect(cached.status).toBe('ok');
            } else {
              // 'unsupported'
              expect(cached.status).toBe('unsupported');
            }
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
