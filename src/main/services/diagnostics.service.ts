// Diagnostics export service — builds a redacted snapshot of the
// application's internal state for debugging / support bundles.
//
// References:
//   - design.md §`diagnostics.export`, §Property 11
//   - PLAN.md §Data Protection
//   - network-quick-actions/design.md §Diagnostics (Requirement 8.4,
//     Requirement 12.4)
//
// Key invariants:
//   - No secret value (from the `secrets` table) appears in the
//     serialized output.
//   - Any key matching `/secret|token|key|cookie|authorization/i` has
//     its value replaced with `"<redacted>"`.
//   - Embedded credentials in URLs are stripped.
//   - `recentConfigSwitches` exposes at most the last 10 `'end'` rows
//     from `openclash_config_changes`, projected to a small audit
//     summary; `'start'` rows (which carry no `result_code` /
//     `duration_ms`) are filtered out.
//   - `managementInterface.url` is run through `stripUrlCredentials`
//     before redaction (defence in depth — the settings schema
//     already rejects URLs with embedded userinfo).

import type {
  AppSettings,
  CapabilityResult,
  CollectorHealthRow,
  DiagnosticsReport,
  ManagementInterfaceDiagnosticsSummary,
  ProviderAuthDiagnosticsEntry,
  RecentConfigSwitchEntry,
} from '../types';
import type {
  CollectorHealthRepository,
  OpenClashConfigChangesRepository,
  ProviderAuthRepository,
  SettingsRepository,
} from '../store/repositories';
import { readCapabilityResults } from '../collectors/usage/Collector';
import { APP_SETTINGS_KEY } from '../store/repositories';
import { diagnosticsRow } from './provider_auth.service';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DiagnosticsServiceDeps {
  settings: SettingsRepository;
  collectorHealth: CollectorHealthRepository;
  /**
   * Source for the `recentConfigSwitches` summary
   * (network-quick-actions Requirement 8.4). Optional so existing
   * tests / callers that only care about the legacy fields keep
   * compiling; when omitted, `recentConfigSwitches` falls back to an
   * empty array.
   */
  openClashConfigChanges?: OpenClashConfigChangesRepository;
  /**
   * Source for the `providerAuthAccounts` summary
   * (cpa-quota-import Requirement 13.4). Optional for the same
   * reason as `openClashConfigChanges` — when omitted, the field is
   * an empty array. Each row is projected through
   * {@link diagnosticsRow} so the report carries only the redacted
   * troubleshooting columns (no `label` / `accountId` / `projectId`).
   */
  providerAuth?: ProviderAuthRepository;
  /** Returns all known secret plaintext values (used for value-based redaction). */
  getSecretValues: () => string[];
}

export interface DiagnosticsService {
  export(): DiagnosticsReport;
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_RE = /secret|token|key|cookie|authorization/i;
const REDACTED = '<redacted>';
const RECENT_CONFIG_SWITCHES_LIMIT = 10;

/**
 * Strip `username` and `password` from a URL string.
 * Returns the original string unchanged if it is not a valid URL.
 */
function stripUrlCredentials(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * Deep-walk an object, redacting sensitive values in-place.
 *
 * Rules:
 *  1. If a leaf string equals one of `secretValues` → `"<redacted>"`
 *  2. If the *key* matches SENSITIVE_KEY_RE → value becomes `"<redacted>"`
 *  3. If the key is `controllerUrl` or `url` → strip embedded credentials
 *
 * Handles circular references defensively via a `Set<object>` guard.
 */
function redactObject(
  obj: unknown,
  secretValues: Set<string>,
  seen: Set<object> = new Set(),
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    // Leaf — if it's a string that matches a secret, redact.
    if (typeof obj === 'string' && secretValues.has(obj)) {
      return REDACTED;
    }
    return obj;
  }

  // Circular reference guard.
  if (seen.has(obj as object)) {
    return '[Circular]';
  }
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const val = obj[i];
      if (typeof val === 'string') {
        obj[i] = secretValues.has(val) ? REDACTED : val;
      } else {
        obj[i] = redactObject(val, secretValues, seen);
      }
    }
    return obj;
  }

  // Plain object.
  const record = obj as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    const val = record[k];

    // Key-based redaction takes priority.
    if (SENSITIVE_KEY_RE.test(k)) {
      record[k] = REDACTED;
      continue;
    }

    // Special handling for URL-bearing fields. Both `controllerUrl`
    // and the management interface's `url` may carry embedded
    // credentials in pathological inputs (the schema rejects them on
    // write, but the report acts as a defense-in-depth seam).
    if ((k === 'controllerUrl' || k === 'url') && typeof val === 'string') {
      record[k] = stripUrlCredentials(val);
      continue;
    }

    // Recurse.
    if (typeof val === 'string') {
      record[k] = secretValues.has(val) ? REDACTED : val;
    } else if (typeof val === 'object' && val !== null) {
      record[k] = redactObject(val, secretValues, seen);
    }
    // Non-string primitives (number, boolean) pass through unchanged.
  }

  return record;
}

/**
 * Project the last 10 `'end'` rows from `openclash_config_changes`
 * into the small {@link RecentConfigSwitchEntry} shape exposed by the
 * diagnostics report.
 *
 * Only rows whose `status === 'end'` and whose `resultCode` is
 * non-null are surfaced — the orchestrator always writes an `'end'`
 * row before releasing the switch lock (network-quick-actions
 * Property 6), so a `null` result code would imply a corrupt row and
 * is defensively filtered out.
 *
 * The repository's `recent(limit)` already returns rows ordered
 * newest-first; we over-fetch a small multiple of the surfaced limit
 * so the post-filter still has 10 entries when many `'start'` rows
 * preceded the `'end'` rows in the recent past.
 */
function buildRecentConfigSwitches(
  repo: OpenClashConfigChangesRepository | undefined,
): RecentConfigSwitchEntry[] {
  if (!repo) {
    return [];
  }
  const rows = repo.recent(RECENT_CONFIG_SWITCHES_LIMIT * 2);
  const result: RecentConfigSwitchEntry[] = [];
  for (const row of rows) {
    if (row.status !== 'end') {
      continue;
    }
    if (row.resultCode === null) {
      continue;
    }
    result.push({
      targetPath: row.targetPath,
      resultCode: row.resultCode,
      timestamp: row.timestamp,
      durationMs: row.durationMs,
    });
    if (result.length >= RECENT_CONFIG_SWITCHES_LIMIT) {
      break;
    }
  }
  return result;
}

/**
 * Build the redacted {@link ManagementInterfaceDiagnosticsSummary}
 * from the live `AppSettings`. Falls back to safe defaults when the
 * settings blob is missing or only partially populated so the report
 * never throws on a fresh install.
 */
function buildManagementInterfaceSummary(
  appSettings: Partial<AppSettings> | undefined,
): ManagementInterfaceDiagnosticsSummary {
  const mgmt = appSettings?.managementInterface;
  const rawUrl = typeof mgmt?.url === 'string' ? mgmt.url : '';
  const url = stripUrlCredentials(rawUrl);
  const requestTimeoutMs =
    typeof mgmt?.requestTimeoutMs === 'number' ? mgmt.requestTimeoutMs : 0;
  const whitelist = Array.isArray(mgmt?.configFileWhitelist)
    ? mgmt.configFileWhitelist
    : [];
  return {
    url,
    requestTimeoutMs,
    configFileWhitelistCount: whitelist.length,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDiagnosticsService(
  deps: DiagnosticsServiceDeps,
): DiagnosticsService {
  const {
    settings,
    collectorHealth,
    openClashConfigChanges,
    providerAuth,
    getSecretValues,
  } = deps;

  return {
    export(): DiagnosticsReport {
      // 1. Gather raw data.
      const collectors: CollectorHealthRow[] = collectorHealth.list();
      const lastCapability: Record<string, CapabilityResult> =
        readCapabilityResults(settings);

      // 2. Read the canonical AppSettings blob (if present) for both
      //    the controllerUrl redaction and the management interface
      //    summary.
      const appSettings = settings.get<AppSettings>(APP_SETTINGS_KEY);
      const rawControllerUrl =
        typeof appSettings?.controllerUrl === 'string'
          ? appSettings.controllerUrl
          : '';
      const redactedControllerUrl = stripUrlCredentials(rawControllerUrl);

      // 3. Project the last 10 `'end'` rows from
      //    `openclash_config_changes` into the diagnostics summary
      //    (network-quick-actions Requirement 8.4).
      const recentConfigSwitches = buildRecentConfigSwitches(
        openClashConfigChanges,
      );

      // 4. Build the redacted management interface summary
      //    (network-quick-actions Requirement 12.4).
      const managementInterface = buildManagementInterfaceSummary(appSettings);

      // 5. Project every `provider_auth` row through the
      //    diagnostics-only column whitelist
      //    (cpa-quota-import Requirement 13.4). The projection lives
      //    in `provider_auth.service.ts` so the column whitelist has
      //    a single source of truth — `label`, `accountId`, and
      //    `projectId` are deliberately omitted (Q5 resolution).
      const providerAuthAccounts: ProviderAuthDiagnosticsEntry[] =
        providerAuth?.list().map(diagnosticsRow) ?? [];

      // 6. Build the report.
      const report: DiagnosticsReport = {
        generatedAt: Date.now(),
        collectors,
        lastCapability,
        redactedControllerUrl,
        recentConfigSwitches,
        managementInterface,
        providerAuthAccounts,
        schemaVersion: 1,
      };

      // 7. Load secret values for value-based redaction.
      const secretVals = getSecretValues();
      const secretSet = new Set(secretVals.filter((v) => v.length > 0));

      // 8. Deep-redact the entire report. The redaction sieve walks
      //    every nested object and array so the new
      //    `recentConfigSwitches` and `managementInterface` blocks
      //    are also covered (no secret value can survive as a
      //    substring after this pass).
      redactObject(report, secretSet);

      return report;
    },
  };
}
