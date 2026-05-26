// Zod schemas for every IPC payload exposed by the `DesktopApi`
// contract (design.md §IPC Handler Registry, PLAN.md §IPC Interface)
// and for the persisted `AppSettings` shape.
//
// Validation rules mirror design.md §Validation rules:
//   - controllerUrl: http(s)://, non-empty host, port 1..65535
//   - primaryGroups: trimmed non-empty entries
//   - probeUrls: each is http(s)://...; at least 1 entry
//   - routerHealth.port: 1..65535
//   - switchVerifyDelayMs: 0..10000
//   - refreshIntervals.*: >= 1000 ms
//
// The TypeScript shapes in `./types.ts` remain the authoritative
// types; these schemas validate runtime payloads and reject malformed
// IPC inputs at the main-process boundary (Property 12).

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PORT_MIN = 1;
const PORT_MAX = 65535;
const MIN_INTERVAL_MS = 1_000;
const SWITCH_VERIFY_DELAY_MIN = 0;
const SWITCH_VERIFY_DELAY_MAX = 10_000;
const MIN_VERIFY_WINDOW_MS = 1_000;
const MAX_VERIFY_WINDOW_MS = 30_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Path regex for whitelisted OpenClash config files. Pinned to
 * `/etc/openclash/config/*.yaml` (or `.yml`); rejects `..` and other
 * path-traversal forms so a malicious renderer cannot ask the main
 * process to commit `/etc/passwd` as a config path.
 *
 * See network-quick-actions/design.md §Settings Validation (zod).
 */
const CONFIG_PATH_RE = /^\/etc\/openclash\/config\/[A-Za-z0-9._\-]+\.(yaml|yml)$/;

const portSchema = z
  .number()
  .int()
  .min(PORT_MIN, { message: 'port must be >= 1' })
  .max(PORT_MAX, { message: 'port must be <= 65535' });

const intervalMsSchema = z
  .number()
  .int()
  .min(MIN_INTERVAL_MS, {
    message: `refresh interval must be >= ${MIN_INTERVAL_MS} ms`,
  });

const trimmedNonEmpty = z
  .string()
  .trim()
  .min(1, { message: 'must be a non-empty string' });

const httpUrlSchema = trimmedNonEmpty.refine(
  (value) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
      if (parsed.hostname.length === 0) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a http(s):// URL with a non-empty host' },
);

const controllerUrlSchema = trimmedNonEmpty.superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'controllerUrl must be a valid URL',
    });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'controllerUrl must use http:// or https://',
    });
  }
  if (parsed.hostname.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'controllerUrl must include a non-empty host',
    });
  }
  if (parsed.port !== '') {
    const port = Number(parsed.port);
    if (
      !Number.isInteger(port) ||
      port < PORT_MIN ||
      port > PORT_MAX
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'controllerUrl port must be in 1..65535',
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const routerHealthSchema = z
  .object({
    host: trimmedNonEmpty,
    port: portSchema,
  })
  .strict();

export const refreshIntervalsSchema = z
  .object({
    networkMs: intervalMsSchema,
    openclashMs: intervalMsSchema,
    currentNodeMs: intervalMsSchema,
    nodeScanMs: intervalMsSchema,
    usageMs: intervalMsSchema,
    retentionMs: intervalMsSchema,
  })
  .strict();

export const collectorToggleSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

/**
 * URL of the OpenClash management interface (LuCI panel). Must be
 * http(s)://, must not embed userinfo, and must not include a query
 * string or fragment (Requirement 13.6 — credentials cannot be smuggled
 * via `?token=...` or `#password=...`).
 *
 * See network-quick-actions/design.md §Settings Validation (zod).
 */
export const managementUrlSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a valid URL',
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must use http:// or https://',
      });
    }
    if (parsed.username !== '' || parsed.password !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must not contain userinfo',
      });
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must not contain query or fragment',
      });
    }
  });

/**
 * One entry in the user-curated `configFileWhitelist`. `alias` is
 * trimmed non-empty; `path` must match `CONFIG_PATH_RE`.
 *
 * See network-quick-actions/design.md §Settings Validation (zod).
 */
export const managementConfigFileEntrySchema = z
  .object({
    alias: z.string().trim().min(1),
    path: z
      .string()
      .trim()
      .regex(CONFIG_PATH_RE, 'must be /etc/openclash/config/*.yaml'),
  })
  .strict();

/**
 * Full management interface settings block. Pinned to the
 * `'openclash-luci'` discriminator in v1; per-request timeout and the
 * config-file whitelist live here too.
 *
 * See network-quick-actions/design.md §Settings Validation (zod).
 */
export const managementInterfaceSchema = z
  .object({
    kind: z.literal('openclash-luci'),
    url: managementUrlSchema,
    requestTimeoutMs: z
      .number()
      .int()
      .min(MIN_REQUEST_TIMEOUT_MS)
      .max(MAX_REQUEST_TIMEOUT_MS),
    configFileWhitelist: z.array(managementConfigFileEntrySchema),
  })
  .strict();

/**
 * Per-config-switch verify window. Default 8000 ms (set in
 * `buildDefaultAppSettings`); range 1000..30000.
 *
 * See network-quick-actions/design.md §Settings Validation (zod).
 */
export const configSwitchVerifyWindowMsSchema = z
  .number()
  .int()
  .min(MIN_VERIFY_WINDOW_MS)
  .max(MAX_VERIFY_WINDOW_MS);

export const appSettingsSchema = z
  .object({
    controllerUrl: controllerUrlSchema,
    primaryGroups: z.array(trimmedNonEmpty),
    probeUrls: z
      .array(httpUrlSchema)
      .min(1, { message: 'probeUrls must contain at least one URL' }),
    routerHealth: routerHealthSchema,
    switchVerifyDelayMs: z
      .number()
      .int()
      .min(SWITCH_VERIFY_DELAY_MIN, {
        message: `switchVerifyDelayMs must be >= ${SWITCH_VERIFY_DELAY_MIN}`,
      })
      .max(SWITCH_VERIFY_DELAY_MAX, {
        message: `switchVerifyDelayMs must be <= ${SWITCH_VERIFY_DELAY_MAX}`,
      }),
    switchConfirmation: z.boolean(),
    refreshIntervals: refreshIntervalsSchema,
    collectors: z.record(trimmedNonEmpty, collectorToggleSchema),
    autostart: z.boolean(),
    configSwitchVerifyWindowMs: configSwitchVerifyWindowMsSchema,
    managementInterface: managementInterfaceSchema,
  })
  .strict();

/**
 * Partial-update payload accepted by `updateSettings`. Unknown keys are
 * rejected; nested objects retain their own per-field validation but
 * are themselves optional.
 */
export const appSettingsPatchSchema = z
  .object({
    controllerUrl: controllerUrlSchema.optional(),
    primaryGroups: z.array(trimmedNonEmpty).optional(),
    probeUrls: z.array(httpUrlSchema).min(1).optional(),
    routerHealth: routerHealthSchema.optional(),
    switchVerifyDelayMs: z
      .number()
      .int()
      .min(SWITCH_VERIFY_DELAY_MIN)
      .max(SWITCH_VERIFY_DELAY_MAX)
      .optional(),
    switchConfirmation: z.boolean().optional(),
    refreshIntervals: refreshIntervalsSchema.optional(),
    collectors: z.record(trimmedNonEmpty, collectorToggleSchema).optional(),
    autostart: z.boolean().optional(),
    configSwitchVerifyWindowMs: configSwitchVerifyWindowMsSchema.optional(),
    managementInterface: managementInterfaceSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// IPC inputs (every method on `DesktopApi`)
// ---------------------------------------------------------------------------

/** No-argument IPC methods accept either no payload or `undefined`. */
export const emptyInputSchema = z.union([z.undefined(), z.void()]);

export const getDashboardInputSchema = emptyInputSchema;
export const getOpenClashDetailsInputSchema = emptyInputSchema;
export const refreshNowInputSchema = emptyInputSchema;
export const getSettingsInputSchema = emptyInputSchema;
export const getDiagnosticsInputSchema = emptyInputSchema;

export const switchNodeInputSchema = z
  .object({
    groupName: trimmedNonEmpty,
    nodeName: trimmedNonEmpty,
  })
  .strict();

export const usageRangeSchema = z.enum(['today', 'week', 'month']);

export const getUsageSummaryInputSchema = z
  .object({
    range: usageRangeSchema,
  })
  .strict();

export const updateSettingsInputSchema = appSettingsPatchSchema;

export const updateSecretInputSchema = z
  .object({
    key: trimmedNonEmpty,
    value: trimmedNonEmpty,
  })
  .strict();

// ---------------------------------------------------------------------------
// Shared output substructures
// ---------------------------------------------------------------------------

export const healthStatusSchema = z.enum([
  'home_down',
  'openclash_unreachable',
  'node_down',
  'partial_outage',
  'node_slow',
  'healthy',
]);

export const apiOkSchema = z.union([z.boolean(), z.literal('auth_error')]);

export const probeResultSchema = z
  .object({
    ok: z.boolean(),
    latencyMs: z.number().nullable(),
    error: z.string().optional(),
  })
  .strict();

export const probeResultDigestSchema = z
  .object({
    url: z.string(),
    ok: z.boolean(),
    latencyMs: z.number().nullable(),
  })
  .strict();

export const switchErrorCodeSchema = z.enum([
  'http_error',
  'verify_mismatch',
  'verify_timeout',
  'auth_error',
]);

export const switchNodeResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      newCurrent: z.string(),
      verifiedAt: z.number().int(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: switchErrorCodeSchema,
          message: z.string(),
        })
        .strict(),
      actualCurrent: z.string().nullable(),
    })
    .strict(),
]);

export const capabilityResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }).strict(),
  z.object({ status: z.literal('degraded'), reason: z.string() }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string() }).strict(),
  z.object({ status: z.literal('disabled') }).strict(),
]);

// ---------------------------------------------------------------------------
// IPC outputs (for symmetric runtime validation in tests / push channels)
// ---------------------------------------------------------------------------

export const dashboardStateSchema = z
  .object({
    status: healthStatusSchema,
    statusLabel: z.string(),
    generatedAt: z.number().int(),
    router: z
      .object({
        ok: z.boolean(),
        lastChange: z.number().int(),
      })
      .strict(),
    openclash: z
      .object({
        tcpOk: z.boolean(),
        apiOk: apiOkSchema,
        mode: z.string().nullable(),
      })
      .strict(),
    currentNode: z
      .object({
        group: z.string().nullable(),
        node: z.string().nullable(),
        avgLatencyMs: z.number().nullable(),
        probeResults: z.array(probeResultDigestSchema),
        successRate5: z.number().nullable(),
        sparkline: z.array(z.number()),
      })
      .strict(),
    usageToday: z
      .object({
        codex: z.number(),
        gemini: z.number(),
        opencode: z.number(),
      })
      .strict(),
  })
  .strict();

export const nodeViewSchema = z
  .object({
    name: z.string(),
    source: z.string().nullable(),
    lastDelayMs: z.number().nullable(),
    lastDelayAt: z.number().nullable(),
    successRate: z.number().nullable(),
  })
  .strict();

export const groupViewSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    current: z.string(),
    nodes: z.array(nodeViewSchema),
  })
  .strict();

/** Permissive mirror of the Clash `/configs` response (only the fields we read). */
export const configsResponseSchema = z
  .object({
    port: z.number().optional(),
    'socks-port': z.number().optional(),
    'redir-port': z.number().optional(),
    'mixed-port': z.number().optional(),
    mode: z.string().optional(),
    'log-level': z.string().optional(),
    'allow-lan': z.boolean().optional(),
  })
  .passthrough();

/**
 * Permissive mirror of a single entry in Clash's `/proxies` response.
 *
 * The upstream API emits many fields that are not consumed by this app
 * (e.g. `xudp`, `tfo`, `extra`, `alive`, latency-test metadata). We use
 * `.passthrough()` so unknown fields ride along untouched and zod does
 * not reject otherwise valid payloads. Only the fields read by
 * `health.service`, `nodeScan.collector`, and the renderer are typed
 * here.
 */
export const proxyHistoryEntrySchema = z
  .object({
    time: z.string(),
    delay: z.number(),
  })
  .passthrough();

export const proxyEntrySchema = z
  .object({
    type: z.string(),
    name: z.string(),
    now: z.string().optional(),
    current: z.string().optional(),
    all: z.array(z.string()).optional(),
    history: z.array(proxyHistoryEntrySchema).optional(),
    udp: z.boolean().optional(),
  })
  .passthrough();

/**
 * Permissive mirror of Clash's `/proxies` response. The top level is
 * exactly `{ proxies: <map> }`; any other top-level key is rejected
 * because it would imply a controller version we do not understand.
 */
export const proxiesResponseSchema = z
  .object({
    proxies: z.record(z.string(), proxyEntrySchema),
  })
  .strict();

export const openClashDetailsSchema = z
  .object({
    configs: configsResponseSchema.nullable(),
    groups: z.array(groupViewSchema),
    lastSnapshotAt: z.number().int().nullable(),
    apiState: z.enum(['ok', 'auth_error', 'unreachable']),
  })
  .strict();

export const usageProviderSummarySchema = z
  .object({
    provider: z.string(),
    status: z.enum(['ok', 'degraded', 'unavailable', 'disabled']),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheTokens: z.number().int().nonnegative(),
    costUsd: z.number().nullable(),
    eventCount: z.number().int().nonnegative(),
    reason: z.string().optional(),
  })
  .strict();

export const usageSummarySchema = z
  .object({
    range: usageRangeSchema,
    perProvider: z.array(usageProviderSummarySchema),
  })
  .strict();

export const collectorHealthRowSchema = z
  .object({
    collector: z.string(),
    lastRunAt: z.number().int().nullable(),
    lastSuccessAt: z.number().int().nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: z.number().int().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Closed set of result codes accepted in `recentConfigSwitches[*].resultCode`.
 * Mirrors `ConfigChangeResultCode` from `store/repositories.ts`
 * (network-quick-actions Requirement 16.1) — kept here as a runtime
 * source-of-truth so the schema rejects rows whose `result_code`
 * column drifts from the closed enum.
 */
const configChangeResultCodeSchema = z.enum([
  'ok',
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
  'not_supported',
]);

const recentConfigSwitchEntrySchema = z
  .object({
    targetPath: z.string(),
    resultCode: configChangeResultCodeSchema,
    timestamp: z.number().int(),
    durationMs: z.number().int().nullable(),
  })
  .strict();

const managementInterfaceDiagnosticsSummarySchema = z
  .object({
    url: z.string(),
    requestTimeoutMs: z.number().int().nonnegative(),
    configFileWhitelistCount: z.number().int().nonnegative(),
  })
  .strict();

export const diagnosticsReportSchema = z
  .object({
    generatedAt: z.number().int(),
    collectors: z.array(collectorHealthRowSchema),
    lastCapability: z.record(z.string(), capabilityResultSchema),
    redactedControllerUrl: z.string(),
    recentConfigSwitches: z.array(recentConfigSwitchEntrySchema),
    managementInterface: managementInterfaceDiagnosticsSummarySchema,
    schemaVersion: z.number().int().nonnegative(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Network Quick Actions IPC schemas (network-quick-actions spec, task 10.2)
// ---------------------------------------------------------------------------
//
// These schemas back the three new `desktop:` channels added in task
// 10.1: `getNetworkQuickActions`, `switchOpenClashConfig`, and
// `clearManagementCredentials`. They are wired into the IPC handler
// registry via `desktopApiSchemas` below so any malformed payload is
// rejected with `{ ok: false, error: { code: 'validation', ... } }`
// before the underlying service is ever invoked (carries forward
// parent design Property 12 / network-quick-actions Property 17).

/**
 * Closed enum of management-client error codes. Mirrors
 * `ManagementErrorCode` declared in
 * `services/openclash.management.service.ts`; kept here as a runtime
 * source-of-truth so settings/audit/diagnostics validators all share
 * the same exhaustive set (Requirement 16.1).
 */
export const managementErrorCodeSchema = z.enum([
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
  'not_supported',
]);

/**
 * Single entry in the Quick_Node_Card candidate list. Mirrors
 * `QuickNodeCandidate` from `services/quickNode.ranking.ts`. The
 * ranking helper guarantees `avgLatencyMs` is non-null for every
 * survivor, but the type stays nullable to match the design contract.
 */
export const quickNodeCandidateSchema = z
  .object({
    nodeName: z.string(),
    avgLatencyMs: z.number().nullable(),
    okSamples: z.number().int().nonnegative(),
    lastOk: z.boolean(),
  })
  .strict();

/**
 * Full payload returned by `desktop:getNetworkQuickActions`. Drives
 * every visible affordance on the expanded window's Quick Actions
 * Panel. See network-quick-actions/design.md §IPC Surface for the
 * field-level contract.
 */
export const networkQuickActionsSchema = z
  .object({
    primaryGroup: z
      .object({
        name: z.string().nullable(),
        currentNode: z.string().nullable(),
        candidates: z.array(quickNodeCandidateSchema),
      })
      .strict(),
    configFiles: z
      .object({
        activePath: z.string().nullable(),
        whitelist: z.array(
          z
            .object({
              alias: z.string(),
              path: z.string(),
              isActive: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
    management: z
      .object({
        configured: z.boolean(),
        reachable: z.boolean(),
        consecutiveFailures: z.number().int().nonnegative(),
        lastErrorCode: managementErrorCodeSchema.nullable(),
      })
      .strict(),
    lastConfigSwitch: z
      .object({
        targetPath: z.string(),
        resultCode: z.union([
          managementErrorCodeSchema,
          z.literal('ok'),
        ]),
        timestamp: z.number().int(),
      })
      .strict()
      .nullable(),
    switchInProgress: z.union([
      z.literal(false),
      z.object({ kind: z.literal('config') }).strict(),
      z
        .object({
          kind: z.literal('node'),
          group: z.string(),
        })
        .strict(),
    ]),
  })
  .strict();

/**
 * Result of `desktop:switchOpenClashConfig`. Mirrors `ConfigSwitchResult`
 * from `services/openclash.management.service.ts`; the orchestrator
 * uses these fields verbatim when writing the `'end'` audit row.
 */
export const configSwitchResultSchema = z
  .object({
    ok: z.boolean(),
    startPath: z.string().nullable(),
    targetPath: z.string(),
    finalPath: z.string().nullable(),
    error: z
      .object({
        code: managementErrorCodeSchema,
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** No-argument input for `desktop:getNetworkQuickActions`. */
export const getNetworkQuickActionsInputSchema = emptyInputSchema;

/**
 * Input for `desktop:switchOpenClashConfig`. The schema validates the
 * shape only — `targetPath` is additionally checked against the live
 * `settings.managementInterface.configFileWhitelist[*].path` set
 * inside the handler (task 10.4) because the whitelist mutates at
 * runtime and cannot be encoded in a static zod schema.
 */
export const switchOpenClashConfigInputSchema = z
  .object({
    targetPath: trimmedNonEmpty,
  })
  .strict();

/** No-argument input for `desktop:clearManagementCredentials`. */
export const clearManagementCredentialsInputSchema = emptyInputSchema;

// ---------------------------------------------------------------------------
// Push channel schemas
// ---------------------------------------------------------------------------

export const desktopPushChannelSchema = z.enum([
  'dashboard.updated',
  'openclash.updated',
  'navigate-tab',
]);

// ---------------------------------------------------------------------------
// Aggregate schema map (for IPC dispatch tables)
// ---------------------------------------------------------------------------

/**
 * Map from `DesktopApi` method name to its input/output schemas. Wired
 * into the IPC handler registry in task 3.11; keeping the map in this
 * module ensures every public method has a schema.
 */
export const desktopApiSchemas = {
  getDashboard: {
    input: getDashboardInputSchema,
    output: dashboardStateSchema,
  },
  getOpenClashDetails: {
    input: getOpenClashDetailsInputSchema,
    output: openClashDetailsSchema,
  },
  switchNode: {
    input: switchNodeInputSchema,
    output: switchNodeResultSchema,
  },
  refreshNow: {
    input: refreshNowInputSchema,
    output: z.void(),
  },
  getUsageSummary: {
    input: getUsageSummaryInputSchema,
    output: usageSummarySchema,
  },
  getSettings: {
    input: getSettingsInputSchema,
    output: appSettingsSchema,
  },
  updateSettings: {
    input: updateSettingsInputSchema,
    output: appSettingsSchema,
  },
  updateSecret: {
    input: updateSecretInputSchema,
    output: z.void(),
  },
  getDiagnostics: {
    input: getDiagnosticsInputSchema,
    output: diagnosticsReportSchema,
  },
  openExpanded: {
    input: z.undefined().or(z.null()).or(z.void()),
    output: z.void(),
  },
  getQuotaStatus: {
    input: z.undefined().or(z.null()).or(z.void()),
    output: z.object({
      snapshots: z.array(z.object({
        provider: z.string(),
        capturedAt: z.number(),
        source: z.enum(['local_log', 'remote_api']),
        windows: z.array(z.object({
          name: z.string(),
          percentLeft: z.number().nullable(),
          resetAt: z.number().nullable(),
          windowSeconds: z.number().nullable(),
        })),
      })),
    }),
  },
  // Network Quick Actions panel (network-quick-actions spec, task 10.2).
  // Malformed payloads on any of these three channels are rejected at
  // the IPC boundary with `{ ok: false, error: { code: 'validation',
  // ... } }`; the handlers (task 10.3..10.5) never see the raw value.
  getNetworkQuickActions: {
    input: getNetworkQuickActionsInputSchema,
    output: networkQuickActionsSchema,
  },
  switchOpenClashConfig: {
    input: switchOpenClashConfigInputSchema,
    output: configSwitchResultSchema,
  },
  clearManagementCredentials: {
    input: clearManagementCredentialsInputSchema,
    output: z.void(),
  },
} as const;

export type DesktopApiMethod = keyof typeof desktopApiSchemas;
