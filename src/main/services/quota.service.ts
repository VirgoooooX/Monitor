// Quota service — per-account, multi-provider quota aggregator.
//
// References:
//   - cpa-quota-import/design.md §Quota service refactor
//   - cpa-quota-import/design.md §Foundation Phase placeholder adapters
//   - cpa-quota-import/design.md §Codex local-log fallback path
//   - cpa-quota-import/design.md §Aggregator startup
//   - cpa-quota-import/requirements.md Requirement 11.1, 11.2, 11.3,
//       11.5, 11.6, 11.7, 16.4
//
// =============================================================================
// BEHAVIOUR SUMMARY — READ BEFORE TOUCHING THIS FILE
// =============================================================================
//
// `getQuotaStatus()` is the renderer-hot path. It returns the in-memory
// cache verbatim and never decrypts a secret or talks to the network.
// When the oldest cache entry is older than `REMOTE_THROTTLE_MS` we fire
// `refresh()` in the background; the caller sees the previous (possibly
// stale) snapshots immediately so the UI never waits.
//
// `refresh({ id?, provider? })` enumerates the target accounts, applies
// the per-account 5-minute throttle, dispatches each via
// `Promise.allSettled` so one account's rejection cannot poison another,
// persists `last_quota_at` / `last_error_*` on each row, and finally
// writes the merged snapshots to `settings.quota.snapshots`.
//
// Adapters in v1 are Foundation-Phase placeholders that return
// `status='unsupported'` — this module exercises the dispatch /
// throttle / cache / persistence skeleton so v1.1 only has to swap the
// adapter bodies.
//
// The cache is keyed by `providerAuthId` plus a single sentinel
// `__codex_local__` for the legacy Codex local-log fallback.
// `secretsAdmin.get` failures (decryption / unavailable) are caught
// here and translated into a synthesized snapshot with
// `status='unavailable'`, `lastErrorCode='auth_expired'` so a single
// corrupted secret never blocks other accounts.
//
// =============================================================================

import type {
  ProviderAuthErrorCode,
  ProviderAuthSecretPayload,
  ProviderId,
  QuotaSnapshot,
  QuotaStatus,
} from '../types';
import type {
  ProviderAuthRepository,
  ProviderAuthRow,
  SettingsRepository,
} from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';
import type {
  ProviderAdapter,
  ProviderAdapterRefreshInput,
} from './quota/adapters';
import { isProviderAuthErrorCode } from './quota/adapters/common';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Settings key used to hydrate the in-memory cache on boot. */
const SETTINGS_KEY = 'quota.snapshots';

/**
 * Sentinel cache key used for the Codex local-JSONL fallback path
 * (Requirement 11.6). Distinct from any UUID so it can coexist with
 * `provider_auth.id` keys without collision.
 */
const CODEX_LOCAL_KEY = '__codex_local__';

/** Per-account 5-minute throttle. */
const REMOTE_THROTTLE_MS = 5 * 60 * 1000;

/** Maximum length of a redacted error message (mirror of `bound()` in `provider_auth.service`). */
const MAX_ERROR_MESSAGE_LEN = 80;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface QuotaService {
  /**
   * Hot-path read of the cached snapshots. Never blocks on adapter or
   * secret I/O — when the oldest entry is older than
   * `REMOTE_THROTTLE_MS` a background `refresh()` is fired but the
   * caller still receives the existing cache immediately.
   */
  getQuotaStatus(): Promise<QuotaStatus>;
  /**
   * Force a refresh.
   *   - `{ id }`         — refresh exactly that account.
   *   - `{ provider }`   — refresh every account for that provider.
   *   - `{}` / undefined — refresh every account.
   * Always returns the post-refresh cache (the same shape as
   * `getQuotaStatus()`).
   */
  refresh(input?: { id?: string; provider?: ProviderId }): Promise<QuotaStatus>;
}

export interface QuotaServiceDeps {
  settings: SettingsRepository;
  providerAuth: ProviderAuthRepository;
  secrets: SecretsAdmin;
  adapters: Record<ProviderId, ProviderAdapter>;
  /**
   * Codex local JSONL fallback. Invoked when the refresh scope
   * includes `codex` AND no `provider_auth` row exists for `codex`
   * (Requirement 11.6). When omitted, the fallback path is silently
   * skipped — used by tests that do not exercise the legacy code path.
   */
  parseCodexLocalRateLimits?: () => Promise<QuotaSnapshot | null>;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Cache shape
// ---------------------------------------------------------------------------

/** `providerAuthId` for adapter snapshots, or `__codex_local__` for the fallback. */
type CacheKey = string;

interface CacheEntry {
  snapshot: QuotaSnapshot;
  /**
   * The most recent snapshot whose adapter call returned
   * `status='ok'`. Used by the stale-retention path so that a
   * `success → unsupported → reject` sequence still preserves the
   * original successful snapshot's `windows` / `kind` / `rawPlanLabel`
   * etc. (Requirement 11.2 — "保留上一次成功值"). `undefined` if no
   * successful refresh has been observed for this account yet.
   */
  lastSuccessSnapshot: QuotaSnapshot | undefined;
  /** Last time the entry was successfully refreshed (epoch ms). */
  lastFetchedAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bound(message: string): string {
  return message.length <= MAX_ERROR_MESSAGE_LEN
    ? message
    : message.slice(0, MAX_ERROR_MESSAGE_LEN);
}

/**
 * Build a synthesized snapshot for an account whose secret could not
 * be decrypted. Per Requirement 1.4 the message is bounded and never
 * contains the underlying error's text (which may carry plaintext
 * fragments).
 */
function buildUnavailableSnapshot(
  account: ProviderAuthRow,
  capturedAt: number,
): QuotaSnapshot {
  return {
    provider: account.provider,
    capturedAt,
    source: 'imported_auth',
    windows: [],
    providerAuthId: account.id,
    accountLabel: account.label,
    accountId: account.accountId,
    projectId: account.projectId,
    kind: 'health',
    status: 'unavailable',
    rawPlanLabel: null,
    modelGroup: null,
    lastErrorCode: 'auth_expired',
    lastErrorMessage: bound('secret payload could not be decrypted'),
  };
}

/**
 * Mark a previously cached snapshot as `stale` after a failed
 * adapter call. The previous `windows` and `kind` survive so the UI
 * can keep displaying the last-known-good values; only `status` and
 * `lastError*` are overwritten. Mirrors Requirement 6.4 + 11.2.
 */
function markStale(
  previous: QuotaSnapshot,
  capturedAt: number,
  errorCode: ProviderAuthErrorCode,
  errorMessage: string,
): QuotaSnapshot {
  return {
    ...previous,
    capturedAt,
    status: 'stale',
    lastErrorCode: errorCode,
    lastErrorMessage: bound(errorMessage),
  };
}

/** Map an arbitrary thrown value onto a closed error code + bounded message. */
function classifyError(err: unknown): {
  code: ProviderAuthErrorCode;
  message: string;
} {
  if (err instanceof Error) {
    // Preserve known closed-set names; everything else collapses to
    // `network_error`. We deliberately do not propagate the original
    // message verbatim — adapters are expected to throw with already
    // sanitised messages, but we re-bound here as defence in depth.
    const name = err.name;
    if (name === 'SecretsUnavailableError') {
      return { code: 'auth_missing', message: 'secret storage unavailable' };
    }
    if (name === 'SecretsDecryptError') {
      return {
        code: 'auth_expired',
        message: 'secret payload could not be decrypted',
      };
    }
    const maybeCoded = err as Error & { code?: unknown };
    if (isProviderAuthErrorCode(maybeCoded.code)) {
      return { code: maybeCoded.code, message: bound(err.message) };
    }
    return { code: 'network_error', message: bound(err.message) };
  }
  if (
    err !== null &&
    typeof err === 'object' &&
    isProviderAuthErrorCode((err as { code?: unknown }).code)
  ) {
    const message = (err as { message?: unknown }).message;
    return {
      code: (err as { code: ProviderAuthErrorCode }).code,
      message: bound(typeof message === 'string' ? message : String((err as { code: ProviderAuthErrorCode }).code)),
    };
  }
  return { code: 'network_error', message: 'adapter rejected' };
}

/** Hydrate the cache map from the persisted `settings.quota.snapshots` blob. */
function loadPersistedSnapshots(
  settings: SettingsRepository,
): QuotaSnapshot[] {
  try {
    const stored = settings.get<QuotaSnapshot[]>(SETTINGS_KEY);
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  const getClock = deps.now ?? Date.now;

  // ---------------------------------------------------------------------
  // Boot path: hydrate cache from settings, mark all as stale, then
  // reconcile against `providerAuth.list()` (drop entries whose
  // `providerAuthId` is no longer registered). The Codex local-log
  // sentinel is preserved unconditionally — its `providerAuthId` is
  // null and it survives until the user imports a Codex auth file.
  // ---------------------------------------------------------------------
  const cache = new Map<CacheKey, CacheEntry>();
  {
    const persisted = loadPersistedSnapshots(deps.settings);
    // Only enabled rows are eligible to participate in the cache —
    // a row that was disabled before shutdown should not surface a
    // stale snapshot on the next boot.
    const liveIds = new Set(
      deps.providerAuth.list().filter((row) => row.enabled).map((row) => row.id),
    );
    for (const snap of persisted) {
      const key =
        snap.providerAuthId !== null ? snap.providerAuthId : CODEX_LOCAL_KEY;
      // Drop snapshots whose underlying provider_auth row has been
      // deleted between sessions (Requirement 11.5 reconciliation
      // applied at boot rather than at refresh time).
      if (key !== CODEX_LOCAL_KEY && !liveIds.has(key)) continue;
      // Drop the legacy Codex local-log sentinel unconditionally
      // when no fallback hook is wired (the AI Accounts unification
      // path). Without this, a previous session that ran with the
      // fallback enabled would persist its `__codex_local__`
      // snapshot to settings, and `getQuotaStatus()` would surface
      // it on the next boot even though no account exists.
      if (key === CODEX_LOCAL_KEY && deps.parseCodexLocalRateLimits === undefined) {
        continue;
      }
      // A persisted snapshot whose last persisted `status` was `'ok'`
      // OR `'stale'` represents a former successful refresh whose
      // `windows` / `kind` / `rawPlanLabel` survived to this boot.
      // `'unsupported'` and `'unavailable'` were never successes, so
      // their `lastSuccessSnapshot` is `undefined`. The hydrated
      // entry's visible `status` is forced to `'stale'` so the UI
      // shows last-known-good values until the first refresh of the
      // session lands (Requirement 11.2).
      const wasSuccess = snap.status === 'ok' || snap.status === 'stale';
      cache.set(key, {
        snapshot: { ...snap, status: 'stale' },
        lastSuccessSnapshot: wasSuccess ? { ...snap, status: 'ok' } : undefined,
        // Force the throttle to elapse on first refresh — a stale
        // boot snapshot must never starve the next adapter call.
        lastFetchedAt: 0,
      });
    }
  }

  // Tracks an in-flight background refresh fired by `getQuotaStatus`
  // so concurrent renderer calls do not stack up duplicate work.
  let backgroundRefreshInFlight: Promise<void> | null = null;

  // -----------------------------------------------------------------
  // getQuotaStatus
  // -----------------------------------------------------------------
  async function getQuotaStatus(): Promise<QuotaStatus> {
    const now = getClock();

    // Decide whether to trigger a fire-and-forget background refresh.
    // We only fire when the OLDEST entry is older than the throttle —
    // a single fresh entry keeps the whole cache "warm" so we do not
    // pound the upstream when one account refreshed in the last
    // minute and another is overdue (the next manual refresh will
    // pick up the overdue account because the throttle is per-key).
    if (cache.size === 0 || isCacheStale(now)) {
      // Don't await — return cached immediately.
      if (backgroundRefreshInFlight === null) {
        backgroundRefreshInFlight = refresh()
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            backgroundRefreshInFlight = null;
          });
      }
    }

    return { snapshots: snapshotList() };
  }

  function isCacheStale(now: number): boolean {
    let oldest = Number.POSITIVE_INFINITY;
    for (const entry of cache.values()) {
      if (entry.lastFetchedAt < oldest) oldest = entry.lastFetchedAt;
    }
    if (oldest === Number.POSITIVE_INFINITY) return true;
    return now - oldest > REMOTE_THROTTLE_MS;
  }

  function snapshotList(): QuotaSnapshot[] {
    return Array.from(cache.values()).map((entry) => entry.snapshot);
  }

  // -----------------------------------------------------------------
  // refresh
  // -----------------------------------------------------------------
  async function refresh(input?: {
    id?: string;
    provider?: ProviderId;
  }): Promise<QuotaStatus> {
    const now = getClock();

    // 1. Enumerate target accounts.
    //    Disabled (`enabled=false`) rows are filtered out here so
    //    every downstream branch (throttle / dispatch / cache eviction)
    //    treats them as if they did not exist — the renderer's
    //    `enabled` toggle is the single source of truth for "should
    //    this account be polled".
    const allRows = deps.providerAuth.list();
    const enabledRows = allRows.filter((r) => r.enabled);
    let targets: ProviderAuthRow[];
    if (input?.id !== undefined) {
      targets = enabledRows.filter((r) => r.id === input.id);
    } else if (input?.provider !== undefined) {
      targets = enabledRows.filter((r) => r.provider === input.provider);
    } else {
      targets = enabledRows;
    }

    // 1a. A targeted `{ id }` refresh against a disabled account
    //     is a no-op for the adapter, but we still drop any leftover
    //     cache entry so `getQuotaStatus()` does not surface stale
    //     snapshots for an account the user just paused.
    if (input?.id !== undefined && targets.length === 0) {
      cache.delete(input.id);
    }

    // 2. Drop cache entries whose row no longer exists OR has been
    //    disabled. We only do this on a full-scope refresh ({} /
    //    undefined) so that a targeted `{ id }` refresh does not
    //    silently flush other accounts. Missing rows in a
    //    `{ provider }` scope are handled implicitly by the
    //    per-key throttle below.
    if (input === undefined || (input.id === undefined && input.provider === undefined)) {
      const liveIds = new Set(enabledRows.map((r) => r.id));
      for (const key of Array.from(cache.keys())) {
        if (key === CODEX_LOCAL_KEY) continue;
        if (!liveIds.has(key)) cache.delete(key);
      }
    } else if (input.provider !== undefined && input.id === undefined) {
      // Provider-scoped refresh: prune cache entries for this
      // provider whose row was deleted OR disabled between calls.
      const liveIdsForProvider = new Set(
        enabledRows
          .filter((r) => r.provider === input.provider)
          .map((r) => r.id),
      );
      for (const [key, entry] of Array.from(cache.entries())) {
        if (key === CODEX_LOCAL_KEY) continue;
        if (
          entry.snapshot.provider === input.provider &&
          !liveIdsForProvider.has(key)
        ) {
          cache.delete(key);
        }
      }
    }

    // 3. Per-account dispatch via Promise.allSettled. We split the
    //    targets into "throttled" (skip — reuse cache) and "due"
    //    (call adapter) so one slow adapter does not extend the
    //    throttle window of unrelated accounts.
    type DueAccount = { account: ProviderAuthRow; adapter: ProviderAdapter };
    const due: DueAccount[] = [];
    for (const account of targets) {
      const cached = cache.get(account.id);
      if (
        cached !== undefined &&
        now - cached.lastFetchedAt < REMOTE_THROTTLE_MS
      ) {
        // Throttled — reuse cache, no adapter call.
        continue;
      }
      const adapter = deps.adapters[account.provider];
      if (adapter === undefined) {
        // No adapter registered for this provider — synthesize an
        // `unsupported` snapshot so the cache is consistent.
        const previous = cache.get(account.id);
        cache.set(account.id, {
          snapshot: {
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
            lastErrorMessage: bound('no adapter registered'),
          },
          // An `unsupported` outcome is not a success — preserve any
          // previously observed last-success so a transient
          // adapter-registry gap does not erase last-known-good
          // values.
          lastSuccessSnapshot: previous?.lastSuccessSnapshot,
          lastFetchedAt: now,
        });
        continue;
      }
      due.push({ account, adapter });
    }

    // 4. Build per-account refresh promises, each wrapped so that
    //    secret decryption failures translate to `unavailable`
    //    snapshots without invoking the adapter.
    const dispatched = await Promise.allSettled(
      due.map(async ({ account, adapter }) =>
        runOneAccount(account, adapter, now),
      ),
    );

    // 5. Apply the results to the cache + persist last_* columns on
    //    the underlying provider_auth row.
    for (let i = 0; i < dispatched.length; i++) {
      const outcome = dispatched[i]!;
      const { account } = due[i]!;
      const previous = cache.get(account.id);

      if (outcome.status === 'fulfilled') {
        const snapshot = outcome.value;
        cache.set(account.id, {
          snapshot,
          // Track the last truly successful snapshot separately so
          // a later `unsupported` / `unavailable` / rejected outcome
          // can still surface the previous success's windows on the
          // stale-retention path (Requirement 11.2). Only
          // `status='ok'` qualifies as a success.
          lastSuccessSnapshot:
            snapshot.status === 'ok'
              ? snapshot
              : previous?.lastSuccessSnapshot,
          // Only update the throttle clock when the adapter actually
          // produced a successful (or unsupported) snapshot — an
          // `unavailable` snapshot from a secret failure also counts
          // because re-running the adapter immediately would just
          // hit the same error.
          lastFetchedAt: now,
        });
        // Persist last_quota_at / last_error_* on the row.
        const isErrorSnapshot =
          snapshot.status === 'unavailable' ||
          snapshot.status === 'unsupported' ||
          snapshot.lastErrorCode !== null;
        deps.providerAuth.update(account.id, {
          updatedAt: now,
          lastQuotaAt: snapshot.status === 'ok' ? now : account.lastQuotaAt,
          lastErrorCode: isErrorSnapshot ? snapshot.lastErrorCode : null,
          lastErrorMessage: isErrorSnapshot ? snapshot.lastErrorMessage : null,
        });
      } else {
        // Adapter rejected. Keep the previous LAST-SUCCESSFUL
        // snapshot (if any) and mark it stale so the renderer keeps
        // showing last-known-good `windows` / `kind` /
        // `rawPlanLabel`. Falling back to the most recent cached
        // snapshot (which may itself be `unsupported` from a prior
        // round) would erase those last-known-good values, violating
        // Requirement 11.2. If no successful refresh has ever been
        // observed for this account, synthesize a fresh stale entry
        // so the renderer still sees the row in the cache list.
        const { code, message } = classifyError(outcome.reason);
        const lastSuccess = previous?.lastSuccessSnapshot;
        const stale: QuotaSnapshot =
          lastSuccess !== undefined
            ? markStale(lastSuccess, now, code, message)
            : {
                provider: account.provider,
                capturedAt: now,
                source: 'imported_auth',
                windows: [],
                providerAuthId: account.id,
                accountLabel: account.label,
                accountId: account.accountId,
                projectId: account.projectId,
                kind: 'quota',
                status: 'stale',
                rawPlanLabel: null,
                modelGroup: null,
                lastErrorCode: code,
                lastErrorMessage: bound(message),
              };
        cache.set(account.id, {
          snapshot: stale,
          // Preserve the recorded last-success across the failure so
          // a future `reject → reject` chain still surfaces the same
          // last-known-good values.
          lastSuccessSnapshot: lastSuccess,
          // Throttle the next call — even on failure we should not
          // hammer the upstream. The throttle is the single source
          // of truth for "when may we try again?".
          lastFetchedAt: now,
        });
        deps.providerAuth.update(account.id, {
          updatedAt: now,
          lastErrorCode: code,
          lastErrorMessage: bound(message),
        });
      }
    }

    // 6. Codex local-log fallback (Requirement 11.6). Triggered when
    //    Codex is in scope of the refresh AND there is no enabled
    //    Codex `provider_auth` row. The fallback respects the
    //    throttle on the sentinel key the same way regular accounts
    //    do. A disabled Codex row counts the same as no row at all
    //    for fallback purposes — the user opted out of that account.
    const codexInScope =
      input?.id === undefined &&
      (input?.provider === undefined || input.provider === 'codex');
    const hasCodexRow = enabledRows.some((r) => r.provider === 'codex');
    if (codexInScope && !hasCodexRow && deps.parseCodexLocalRateLimits) {
      const cached = cache.get(CODEX_LOCAL_KEY);
      const due =
        cached === undefined ||
        now - cached.lastFetchedAt >= REMOTE_THROTTLE_MS;
      if (due) {
        try {
          const snap = await deps.parseCodexLocalRateLimits();
          if (snap !== null) {
            cache.set(CODEX_LOCAL_KEY, {
              snapshot: snap,
              // Treat a fresh local-log snapshot with `status='ok'`
              // as the new last-success for the Codex sentinel.
              lastSuccessSnapshot:
                snap.status === 'ok' ? snap : cached?.lastSuccessSnapshot,
              lastFetchedAt: now,
            });
          } else if (cached !== undefined) {
            // No fresh snapshot — keep the previous one but mark it
            // stale so the UI knows the local log went silent.
            const lastSuccess = cached.lastSuccessSnapshot ?? cached.snapshot;
            cache.set(CODEX_LOCAL_KEY, {
              snapshot: markStale(
                lastSuccess,
                now,
                'parse_error',
                'no rate_limit found in latest Codex session log',
              ),
              lastSuccessSnapshot: cached.lastSuccessSnapshot,
              lastFetchedAt: now,
            });
          }
        } catch (err) {
          // Local-log parsing failures are non-fatal — drop them on
          // the floor; the previous snapshot (if any) survives.
          if (cached !== undefined) {
            const { code, message } = classifyError(err);
            const lastSuccess = cached.lastSuccessSnapshot ?? cached.snapshot;
            cache.set(CODEX_LOCAL_KEY, {
              snapshot: markStale(lastSuccess, now, code, message),
              lastSuccessSnapshot: cached.lastSuccessSnapshot,
              lastFetchedAt: now,
            });
          }
        }
      }
    } else if (codexInScope && hasCodexRow) {
      // A Codex provider_auth row took over — drop the legacy
      // sentinel so the renderer does not see two Codex entries.
      cache.delete(CODEX_LOCAL_KEY);
    }

    // 7. Persist the merged snapshots so the next boot hydrates the
    //    same view.
    const merged = snapshotList();
    try {
      deps.settings.set(SETTINGS_KEY, merged);
    } catch {
      // Persistence is best-effort — a write failure never blocks
      // the renderer (the cache stays authoritative for this run).
    }

    return { snapshots: merged };
  }

  /**
   * Refresh a single account. Catches `secrets.get` failures here so
   * one corrupted ciphertext cannot crash the rest of the
   * `Promise.allSettled` batch — we materialise the failure as an
   * `unavailable` snapshot instead of letting the adapter rejection
   * path handle it (the adapter never ran, after all).
   */
  async function runOneAccount(
    account: ProviderAuthRow,
    adapter: ProviderAdapter,
    now: number,
  ): Promise<QuotaSnapshot> {
    // Lazy decryption: the adapter pulls the payload only if it
    // needs it. If decryption throws, we eagerly synthesize an
    // `unavailable` snapshot so the throttled cache does not
    // continue to call the adapter every refresh.
    let secretError: Error | null = null;
    let secretCache: ProviderAuthSecretPayload | null | undefined;
    const getSecret = (): ProviderAuthSecretPayload | null => {
      if (secretCache !== undefined) return secretCache;
      try {
        const ciphertext = deps.secrets.get(account.secretKey);
        if (ciphertext === null) {
          secretCache = null;
          return null;
        }
        secretCache = JSON.parse(ciphertext) as ProviderAuthSecretPayload;
        return secretCache;
      } catch (err) {
        secretError = err instanceof Error ? err : new Error(String(err));
        secretCache = null;
        return null;
      }
    };

    const refreshInput: ProviderAdapterRefreshInput = {
      account,
      getSecret,
      now,
    };
    const snapshot = await adapter.refresh(refreshInput);

    // If the adapter touched `getSecret` and decryption failed we
    // override its result with the synthesized unavailable snapshot.
    // Foundation-Phase placeholders never call `getSecret`, so this
    // branch is dormant in v1; v1.1 adapters will rely on it.
    if (secretError !== null) {
      return buildUnavailableSnapshot(account, now);
    }
    return snapshot;
  }

  return {
    getQuotaStatus,
    refresh,
  };
}
