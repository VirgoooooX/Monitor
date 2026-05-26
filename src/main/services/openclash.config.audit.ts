// Config_Switch audit writer for the Network Quick Actions panel.
//
// References:
//   - .kiro/specs/network-quick-actions/design.md
//       §`openclash.config.audit.ts` — Config Switch Audit Writer
//       §Property 6 (Audit completeness — exactly two rows per flow,
//                    end before release)
//   - .kiro/specs/network-quick-actions/requirements.md
//       Requirement 8 (audit & observability)
//       Requirement 6 (强制二次确认 — `confirmed` is always `true`)
//
// Why this lives in its own file:
//
// - The `OpenClashConfigChangesRepository` (task 2.2 in
//   `src/main/store/repositories.ts`) speaks the raw SQL contract:
//   it knows about `'start'` / `'end'` rows, the `result_code`
//   enumeration, and the `duration_ms` clamp, but it does not know
//   anything about *flows*. The IPC orchestrator (task 10.4), on the
//   other hand, knows about flows but should not be assembling
//   `ConfigChangeStartInput` / `ConfigChangeEndInput` literals by hand
//   — that would scatter the "always pass `confirmed: true`" rule
//   (Requirement 6) across every call site.
//
// - This module is the single seam that glues the two together. It
//   exposes `recordSwitchStart` / `recordSwitchEnd` helpers shaped
//   around the orchestrator's natural inputs (start clock, end clock,
//   the start-row id it kept around, the resolved start/target/final
//   paths, and a final result code). It computes `durationMs`
//   (`endedAt - startedAt`), pins `confirmed: true`, and forwards the
//   typed payload to the repository.
//
// - Task 6.1 explicitly forbids two things in this layer:
//     1. Reading from `secrets` — the audit writer must never depend
//        on credentials. It only sees plaintext path strings that
//        are already safe for persistence and diagnostics.
//     2. Accepting payload bodies — no HTTP body excerpts, response
//        headers, or LuCI HTML pages flow through this service. The
//        helpers' input shapes deliberately omit any field that
//        could carry such content.
//
// Determinism / failure contract
// ------------------------------
//
// - `recordSwitchStart` returns the freshly assigned row id from the
//   repository so the orchestrator can correlate start ↔ end rows for
//   diagnostics. It does not read the clock; the caller passes `now`
//   (the same timestamp it captured before acquiring the lock), which
//   keeps the helper trivially testable.
//
// - `recordSwitchEnd` computes `durationMs = endedAt - startedAt`
//   here so the orchestrator never has to. The repository clamps the
//   result into `[0, MAX_CONFIG_CHANGE_DURATION_MS]`; we still floor
//   any non-finite or negative diff to `0` defensively, so a wall-
//   clock skew that produces `endedAt < startedAt` cannot poison the
//   row.
//
// - Inserts are wrapped in `try / catch`. Per design.md, "failure to
//   insert a row is logged but never aborts the switch — audit must
//   not gate the user-visible action." `recordSwitchStart` therefore
//   returns `null` on failure (the orchestrator treats `null` as "no
//   start row was written"; the end-row helper will still attempt to
//   write its row). `recordSwitchEnd` swallows the failure entirely
//   — there is no orchestrator decision left to make at that point.

import type {
  ConfigChangeResultCode,
  OpenClashConfigChangesRepository,
} from '../store/repositories';

// ---------------------------------------------------------------------------
// Public surface — types
// ---------------------------------------------------------------------------

/**
 * Inputs accepted by {@link ConfigSwitchAuditService.recordSwitchStart}.
 *
 * - `now` is the wall-clock timestamp (`Date.now()`-shaped) the
 *   orchestrator captured immediately after acquiring the switch lock,
 *   before any management-client call. Passing it explicitly keeps
 *   this helper free of `Date.now()` and lets tests inject a virtual
 *   clock (Property 6 generators rely on this).
 *
 * - `startPath` is the active config path the management client read
 *   immediately before the switch, or `null` when management could
 *   not be reached. The audit row is happy with `null` — the
 *   "start path was unknown" case is a legitimate observation.
 */
export interface RecordSwitchStartInput {
  readonly targetPath: string;
  readonly startPath: string | null;
  readonly now: number;
}

/**
 * Inputs accepted by {@link ConfigSwitchAuditService.recordSwitchEnd}.
 *
 * - `rowId` is the value previously returned by `recordSwitchStart`.
 *   The audit table does not need it — `'end'` rows are written as
 *   independent inserts — but the orchestrator threads it through so
 *   future diagnostics can correlate the pair, and so this interface
 *   loudly fails when a caller forgets to call `recordSwitchStart`
 *   first. `null` is accepted to cover the (already-logged) case
 *   where the start insert itself failed; the end row is still
 *   written so the audit table has at least one row for the flow.
 *
 * - `startedAt` and `endedAt` are wall-clock timestamps. The helper
 *   computes `durationMs = endedAt - startedAt`. The repository
 *   clamps the result; this layer floors anything non-finite or
 *   negative to `0` so the clamp never sees a `NaN`.
 *
 * - `finalPath` is the active config the verify loop observed
 *   (target on success, the unchanged start path on `verify_timeout`,
 *   or `null` when no read ever succeeded). The audit row records
 *   exactly what was observed; it is not the audit writer's job to
 *   second-guess the verify result.
 *
 * - `resultCode` is the closed-set code from the management client
 *   (or `'ok'` on success). `'switch_in_progress'` is intentionally
 *   excluded from {@link ConfigChangeResultCode} because the
 *   orchestrator returns that *before* the audit writer is ever
 *   reached (no `'start'` row was written either — see Property 6).
 */
export interface RecordSwitchEndInput {
  readonly rowId: number | null;
  readonly targetPath: string;
  readonly startPath: string | null;
  readonly finalPath: string | null;
  readonly resultCode: ConfigChangeResultCode;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Thin wrapper around {@link OpenClashConfigChangesRepository} that
 * pins the {@link Requirement6} invariant (`confirmed: true`) and
 * computes `durationMs` from the orchestrator's start / end clocks.
 *
 * The service is intentionally minimal: no `recent` / `latest`
 * surface — those are read paths and belong to the IPC handler that
 * builds {@link NetworkQuickActions}, not to the writer.
 */
export interface ConfigSwitchAuditService {
  /**
   * Persist a `'start'` row. Returns the assigned row id, or `null`
   * if the underlying insert threw. The orchestrator should pass the
   * returned id back to {@link recordSwitchEnd} when the flow ends.
   */
  recordSwitchStart(input: RecordSwitchStartInput): number | null;

  /**
   * Persist an `'end'` row. Never throws — failures are swallowed
   * (and logged via `console.warn`) because audit writes must not
   * gate the user-visible action.
   */
  recordSwitchEnd(input: RecordSwitchEndInput): void;
}

export interface ConfigSwitchAuditDeps {
  readonly repository: OpenClashConfigChangesRepository;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Floor a wall-clock diff into `[0, +Infinity)`. The repository's
 * `clampDurationMs` handles the upper bound; this helper exists so a
 * `NaN` (from `Number(undefined)` or similar caller bugs) never
 * reaches the prepared statement, where it would silently insert as
 * `NULL` and break the "duration_ms is NOT NULL on 'end' rows"
 * invariant.
 */
function safeDurationMs(startedAt: number, endedAt: number): number {
  const diff = endedAt - startedAt;
  if (!Number.isFinite(diff) || diff < 0) {
    return 0;
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Public surface — factory
// ---------------------------------------------------------------------------

export function createConfigSwitchAuditService(
  deps: ConfigSwitchAuditDeps,
): ConfigSwitchAuditService {
  const { repository } = deps;

  return {
    recordSwitchStart({ targetPath, startPath, now }) {
      try {
        return repository.insertStart({
          timestamp: now,
          startPath,
          targetPath,
          // Requirement 6 invariant: every flow that reaches the audit
          // writer was user-confirmed. Pinning `true` here means the
          // orchestrator cannot accidentally pass `false` from a
          // future code path.
          confirmed: true,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          '[openclash.config.audit] recordSwitchStart failed:',
          error,
        );
        return null;
      }
    },

    recordSwitchEnd({
      // `rowId` is accepted for API symmetry / future diagnostics;
      // the repository writes `'end'` rows as independent inserts so
      // we do not need to thread it into the SQL statement.
      rowId: _rowId,
      targetPath,
      startPath,
      finalPath,
      resultCode,
      startedAt,
      endedAt,
    }) {
      try {
        repository.insertEnd({
          timestamp: endedAt,
          startPath,
          targetPath,
          finalPath,
          resultCode,
          durationMs: safeDurationMs(startedAt, endedAt),
          confirmed: true,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          '[openclash.config.audit] recordSwitchEnd failed:',
          error,
        );
      }
    },
  };
}
