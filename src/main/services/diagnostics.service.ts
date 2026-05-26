// Diagnostics export service — builds a redacted snapshot of the
// application's internal state for debugging / support bundles.
//
// References:
//   - design.md §`diagnostics.export`, §Property 11
//   - PLAN.md §Data Protection
//
// Key invariants:
//   - No secret value (from the `secrets` table) appears in the
//     serialized output.
//   - Any key matching `/secret|token|key|cookie|authorization/i` has
//     its value replaced with `"<redacted>"`.
//   - Embedded credentials in URLs are stripped.

import type {
  CapabilityResult,
  CollectorHealthRow,
  DiagnosticsReport,
} from '../types';
import type {
  CollectorHealthRepository,
  SettingsRepository,
} from '../store/repositories';
import { readCapabilityResults } from '../collectors/usage/Collector';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DiagnosticsServiceDeps {
  settings: SettingsRepository;
  collectorHealth: CollectorHealthRepository;
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
 *  3. If the key is `controllerUrl` → strip embedded credentials
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

    // Special handling for controllerUrl.
    if (k === 'controllerUrl' && typeof val === 'string') {
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDiagnosticsService(
  deps: DiagnosticsServiceDeps,
): DiagnosticsService {
  const { settings, collectorHealth, getSecretValues } = deps;

  return {
    export(): DiagnosticsReport {
      // 1. Gather raw data.
      const collectors: CollectorHealthRow[] = collectorHealth.list();
      const lastCapability: Record<string, CapabilityResult> =
        readCapabilityResults(settings);

      // 2. Read the controllerUrl from settings (if present).
      const appSettings = settings.get<{ controllerUrl?: string }>('app.settings');
      const rawUrl = appSettings?.controllerUrl ?? '';
      const redactedControllerUrl = stripUrlCredentials(rawUrl);

      // 3. Build the report.
      const report: DiagnosticsReport = {
        generatedAt: Date.now(),
        collectors,
        lastCapability,
        redactedControllerUrl,
        schemaVersion: 1,
      };

      // 4. Load secret values for value-based redaction.
      const secretVals = getSecretValues();
      const secretSet = new Set(secretVals.filter((v) => v.length > 0));

      // 5. Deep-redact the entire report.
      redactObject(report, secretSet);

      return report;
    },
  };
}
