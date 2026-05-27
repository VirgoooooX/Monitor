// Provider adapter contract for the multi-provider quota aggregator.
//
// Source of truth: cpa-quota-import/design.md §Quota service refactor and
// §Foundation Phase placeholder adapters. Every adapter owns a single
// `(provider, capability)` pair and is invoked once per `(provider_auth.id,
// refresh)` event by `quota.service.ts`.
//
// Adapters never open SQLite, never decrypt secrets directly, and never
// touch the renderer mirror — the service hands them metadata + a lazy
// `getSecret` thunk and expects a `QuotaSnapshot` back. v1 ships every
// adapter as an `unsupported` placeholder; v1.1 swaps the four `official`
// providers for real HTTPS implementations without touching this module.

import type {
  ProviderId,
  QuotaCapability,
  QuotaSnapshot,
  ProviderAuthSecretPayload,
} from '../../../types';
import type { ProviderAuthRow } from '../../../store/repositories';

/**
 * Inputs handed to {@link ProviderAdapter.refresh}. The metadata `account`
 * row is read-only — adapters MUST NOT mutate it. `getSecret` is a thunk
 * that performs the (sometimes expensive, sometimes failing)
 * `safeStorage.decryptString` lazily; an adapter that only needs the
 * account label can skip the call entirely. Returning `null` from
 * `getSecret` signals that the secret is missing or the platform's
 * `safeStorage` is unavailable; the service translates that into a
 * synthesized snapshot with `status: 'unavailable'`.
 */
export interface ProviderAdapterRefreshInput {
  readonly account: ProviderAuthRow;
  readonly getSecret: () => ProviderAuthSecretPayload | null;
  readonly now: number;
  readonly signal?: AbortSignal;
  /**
   * Persist a rotated secret payload back to the encrypted store
   * (and refresh `getSecret`'s in-memory cache). Threaded in by
   * `quota.service.ts`; only adapters that perform OAuth refresh
   * round-trips need this — others can ignore the field.
   *
   * Currently used by the Kiro IDE adapter; v1.1 will extend this
   * to Codex / Claude / Google when their refresh paths land here.
   */
  readonly persistSecret?: (payload: ProviderAuthSecretPayload) => void;
}

/**
 * Per-provider adapter consumed by `quota.service.ts`. Every adapter
 * owns one `ProviderId` and reports its declared `QuotaCapability` so
 * the service can short-circuit (e.g. skip `health_only` adapters when
 * the user only asked for quota windows).
 */
export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly capability: QuotaCapability;
  refresh(input: ProviderAdapterRefreshInput): Promise<QuotaSnapshot>;
}
