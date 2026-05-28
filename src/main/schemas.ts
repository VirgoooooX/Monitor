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
 * URL of the OpenClash management interface (LuCI panel). Either:
 *   - the empty string `''` — the "not configured" sentinel, used by
 *     the seeded default and surfaced in Settings as the empty
 *     placeholder, OR
 *   - a http(s):// URL with no userinfo, query, or fragment
 *     (Requirement 13.6 — credentials cannot be smuggled via
 *     `?token=...` or `#password=...`).
 *
 * The renderer's `validateManagementUrl` mirrors the same accepted
 * forms, and `buildDefaultAppSettings` seeds `''`. Keeping the empty
 * sentinel valid here means the seeded blob round-trips through
 * `appSettingsSchema` cleanly and Save in Settings does not require
 * the user to fill in a URL on first run.
 *
 * See network-quick-actions/design.md §Settings Validation (zod).
 */
export const managementUrlSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (value === '') return;
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

// ---------------------------------------------------------------------------
// CLIProxyAPI compatibility settings
// ---------------------------------------------------------------------------
//
// `cliproxy` carries the live config for the CLIProxyAPI usage queue
// importer. Validation matches the in-code `CliProxySettings` shape
// and the rules pinned by cpa-quota-import/requirements.md
// Requirement 13.2:
//
//   - `managementUrl` is either the empty sentinel `''` ("not
//     configured", used by `buildDefaultAppSettings`) or a valid
//     http(s):// URL with a non-empty host (`httpUrlSchema`).
//   - `authDir` is either `''` (use the platform default, typically
//     `~/.cli-proxy-api`) or a trimmed non-empty path string. The
//     filesystem layer revalidates the path before reading it.
//   - `usageQueueBatchSize` is bounded so a runaway value cannot
//     starve the renderer's IPC queue.
//
// Implemented via `z.union([..., z.literal('')])` so the empty
// sentinel round-trips cleanly while non-empty values get the full
// refinement (see network-quick-actions/design.md §Settings
// Validation for the same pattern on `managementInterface.url`).
export const cliproxySettingsSchema = z
  .object({
    enabled: z.boolean(),
    managementUrl: z.union([httpUrlSchema, z.literal('')]),
    authDir: z.union([trimmedNonEmpty, z.literal('')]),
    usageQueueBatchSize: z.number().int().min(1).max(1_000),
  })
  .strict();

// ---------------------------------------------------------------------------
// Provider Auth (cpa-quota-import)
// ---------------------------------------------------------------------------
//
// Schemas for the closed `ProviderId` enum (Requirement 4.1), the
// closed `ProviderAuthErrorCode` enum (Requirement 10.1), and the
// renderer-visible `ProviderAuthMetadata` projection (design.md
// §IPC channels and schemas). All schemas are `.strict()` so an
// extra unknown key on the wire is rejected at the IPC boundary
// (Property 12 of the parent design; Property 17 of this feature).
//
// Each enum mirrors the TypeScript union exported from `./types.ts`;
// adding or removing a value requires updating both sides in lockstep.

/**
 * Closed `ProviderId` enum. v1 takes the 8 values pinned by
 * `cpa-quota-import/requirements.md` Requirement 4.1; new providers
 * require a follow-up spec + migration.
 */
export const providerIdSchema = z.enum([
  'claude-code',
  'codex',
  'gemini-cli',
  'antigravity',
  'kiro-ide',
  'gemini-api',
  'deepseek',
  'xiaomi',
  'opencode',
  'openai-compatible',
]);

/**
 * Closed `ProviderAuthErrorCode` enum (Requirement 10.1). The order
 * mirrors the TypeScript union for easy diffing; `validation` and
 * `cancelled` are shared across the import / refresh / validate
 * pipelines.
 */
export const providerAuthErrorCodeSchema = z.enum([
  'auth_missing',
  'auth_expired',
  'project_missing',
  'upstream_unauthorized',
  'rate_limited',
  'upstream_changed',
  'network_error',
  'unsupported',
  'parse_error',
  'unsupported_file',
  'cancelled',
  'validation',
]);

/** Closed `QuotaCapability` enum (Requirement 5.1). */
export const quotaCapabilitySchema = z.enum([
  'official',
  'health_only',
  'usage_only',
  'unsupported',
]);

/**
 * Renderer-visible projection of one `provider_auth` row. This is
 * the only Provider_Auth shape allowed to cross the IPC boundary —
 * it carries no token / refresh token / API key / file path /
 * `baseUrl` field, so redaction is structural rather than runtime
 * (`requirements.md` Requirement 1.4 + design.md §Layered Trust
 * Model). `lastErrorMessage` is bounded at 80 characters to match
 * the pre-redaction rule in `provider_auth.service`.
 *
 * Reused as the response shape of `desktop:listProviderAuths` and
 * `desktop:importProviderAuthFile` (design.md §IPC channels and
 * schemas).
 */
export const providerAuthMetadataSchema = z
  .object({
    id: trimmedNonEmpty,
    provider: providerIdSchema,
    label: trimmedNonEmpty,
    source: z.enum(['cpa-auth-file', 'manual-api-key']),
    accountId: z.string().nullable(),
    projectId: z.string().nullable(),
    quotaCapability: quotaCapabilitySchema,
    importedAt: z.number().int(),
    updatedAt: z.number().int(),
    lastValidatedAt: z.number().int().nullable(),
    lastQuotaAt: z.number().int().nullable(),
    lastErrorCode: providerAuthErrorCodeSchema.nullable(),
    lastErrorMessage: z.string().max(80).nullable(),
    enabled: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// QuotaSnapshot (extended for cpa-quota-import)
// ---------------------------------------------------------------------------
//
// Schemas backing the `desktop:getQuotaStatus` envelope. The legacy
// `local_log` / `remote_api` source values stay valid so the Codex
// JSONL fallback path round-trips unchanged; the new `imported_auth`
// / `health_check` values are produced by the per-account adapters
// introduced in v1 (design.md §`QuotaSnapshot` extension).
//
// Permissive on `windows[*]` (omitted fields default to `null`-ish
// in the existing producer code) but strict on the snapshot envelope:
// every per-account field is required so a snapshot persisted by
// the new aggregator never "forgets" its `providerAuthId`.

const quotaWindowSchema = z.object({
  name: z.string(),
  percentLeft: z.number().nullable(),
  resetAt: z.number().nullable(),
  windowSeconds: z.number().nullable(),
});

/**
 * Closed enum of `QuotaSnapshot.source` values. Extended in v1 with
 * `imported_auth` (per-account adapter consuming a Provider_Auth
 * row) and `health_check` (reachability-only providers).
 */
export const quotaSourceSchema = z.enum([
  'local_log',
  'remote_api',
  'imported_auth',
  'health_check',
]);

/** Closed enum of `QuotaSnapshot.kind` values (Requirement 6.1). */
export const quotaKindSchema = z.enum([
  'quota',
  'credits',
  'health',
  'usage',
]);

/**
 * Closed enum of per-snapshot status. Distinct from the IPC-envelope
 * `QuotaStatus` (which carries `snapshots: QuotaSnapshot[]`); the
 * `2` suffix on the TypeScript side avoids the name collision.
 */
export const quotaSnapshotStatusSchema = z.enum([
  'ok',
  'stale',
  'unavailable',
  'unsupported',
]);

/**
 * Full `QuotaSnapshot` shape with the per-account fields added by
 * cpa-quota-import. Mirrors the TypeScript interface in
 * `./types.ts#QuotaSnapshot`. The renderer is allowed to consume
 * every field (none are sensitive — token / refresh token / API key
 * fields live exclusively on the main-only
 * `ProviderAuthSecretPayload` and are never serialised here).
 */
export const quotaSnapshotSchema = z.object({
  provider: z.string(),
  capturedAt: z.number(),
  source: quotaSourceSchema,
  windows: z.array(quotaWindowSchema),
  providerAuthId: z.string().nullable(),
  accountLabel: z.string().nullable(),
  accountId: z.string().nullable(),
  projectId: z.string().nullable(),
  kind: quotaKindSchema,
  status: quotaSnapshotStatusSchema,
  rawPlanLabel: z.string().nullable(),
  modelGroup: z.string().nullable(),
  lastErrorCode: providerAuthErrorCodeSchema.nullable(),
  lastErrorMessage: z.string().max(80).nullable(),
});

// ---------------------------------------------------------------------------
// Appearance (theme system)
// ---------------------------------------------------------------------------
//
// `colorMode` is applied only to the expanded window; `compactTheme`
// is one of five hand-tuned floating-widget presets (see
// `types.ts#CompactTheme`). Both are required at the schema level —
// the boot-time normalize step in `app.ts` fills in defaults for
// settings rows that predate this feature so legacy users never
// trip the strict validator.
const colorModeSchema = z.enum(['dark', 'light']);

const compactThemeSchema = z.enum([
  // v2 design-language presets
  'liquid-glass',
  'material-you',
  'soft-neumorph',
  'paper-dashboard',
  'mint-monitor',
  'device-oled',
  // v1 legacy presets (retained as additional options)
  'obsidian-glass',
  'aurora-ring',
  'holo-grid',
  'liquid-metal',
  'signal-pulse',
]);

const fontScaleSchema = z.number().min(0.9).max(1.2);
const compactZoomSchema = z.number().min(1).max(2);

export const appearanceSchema = z
  .object({
    colorMode: colorModeSchema,
    compactTheme: compactThemeSchema,
    fontScale: fontScaleSchema,
    compactZoom: compactZoomSchema,
  })
  .strict();

const appearancePatchSchema = z
  .object({
    colorMode: colorModeSchema.optional(),
    compactTheme: compactThemeSchema.optional(),
    fontScale: fontScaleSchema.optional(),
    compactZoom: compactZoomSchema.optional(),
  })
  .strict();

/**
 * Kiro IDE auto-refresh policy. See
 * `types.ts#KiroTokenRefreshSettings` for the semantics. Both
 * defaults are `true` — `buildDefaultAppSettings` seeds the same
 * pair, and `normalizeAppSettings` patches in the same defaults
 * for older settings rows that predate this block.
 */
export const kiroTokenRefreshSchema = z
  .object({
    enabled: z.boolean(),
    writeBackAuthFile: z.boolean(),
  })
  .strict();

const kiroTokenRefreshPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    writeBackAuthFile: z.boolean().optional(),
  })
  .strict();

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
    cliproxy: cliproxySettingsSchema,
    appearance: appearanceSchema,
    kiroTokenRefresh: kiroTokenRefreshSchema,
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
    cliproxy: cliproxySettingsSchema.optional(),
    appearance: appearancePatchSchema.optional(),
    kiroTokenRefresh: kiroTokenRefreshPatchSchema.optional(),
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

/** Input for `desktop:resizeCompactWindow`. */
export const resizeCompactWindowInputSchema = z
  .object({
    width: z.number().int().min(56).max(360).optional(),
    height: z.number().int().min(40).max(1200),
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
    buckets: z
      .array(
        z
          .object({
            key: z.string(),
            startTs: z.number().int(),
            perProvider: z.array(
              z
                .object({
                  provider: z.string(),
                  inputTokens: z.number().int().nonnegative(),
                  outputTokens: z.number().int().nonnegative(),
                  cacheTokens: z.number().int().nonnegative(),
                  costUsd: z.number().nullable(),
                  eventCount: z.number().int().nonnegative(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
    bucketGranularity: z.enum(['hour', 'day']).optional(),
    bucketRangeStartTs: z.number().int().optional(),
    bucketRangeEndTs: z.number().int().optional(),
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

/**
 * Per-`provider_auth`-row diagnostics projection (cpa-quota-import
 * Requirement 13.4). Mirrors `ProviderAuthDiagnosticsEntry` in
 * `./types.ts`. By Q5 resolution this whitelist deliberately omits
 * `label`, `accountId`, and `projectId` — only the closed-set
 * troubleshooting fields are validated, and `.strict()` rejects any
 * stray sensitive column that might leak in from a future projection
 * change.
 */
const providerAuthDiagnosticsEntrySchema = z
  .object({
    id: trimmedNonEmpty,
    provider: providerIdSchema,
    quotaCapability: quotaCapabilitySchema,
    lastErrorCode: providerAuthErrorCodeSchema.nullable(),
    lastQuotaAt: z.number().int().nullable(),
    lastValidatedAt: z.number().int().nullable(),
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
    providerAuthAccounts: z.array(providerAuthDiagnosticsEntrySchema),
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
// CPA quota import IPC schemas (cpa-quota-import spec, task 10.2)
// ---------------------------------------------------------------------------
//
// These schemas back the five new `desktop:` channels added in task
// 10.1: `listProviderAuths`, `importProviderAuthFile`,
// `deleteProviderAuth`, `refreshProviderQuota`, and
// `validateProviderAuth`. They are wired into the IPC handler
// registry via `desktopApiSchemas` below so any malformed payload is
// rejected with `{ ok: false, error: { code: 'validation', ... } }`
// at the IPC boundary, before the underlying service is ever invoked
// (carries forward parent design Property 12 / cpa-quota-import
// Requirement 9.6).
//
// Notes on shape:
//   - `importProviderAuthFileInput` carries only `{ provider }`. The
//     renderer never supplies a file path or file content — main
//     opens the OS file dialog itself (design.md §Layered Trust
//     Model + Requirement 8.1).
//   - `refreshProviderQuotaInput` lets the caller scope the refresh
//     by either `id` (single account) or `provider` (every account
//     for that provider). Both fields are optional; an empty object
//     means "refresh everything subject to the per-account 5-minute
//     throttle" (Requirement 11.3).
//   - The output of `desktop:refreshProviderQuota` reuses the same
//     `QuotaStatus` envelope the existing `desktop:getQuotaStatus`
//     channel returns. This keeps the renderer's quota-rendering
//     code path single-sourced.

/**
 * Input for `desktop:importProviderAuthFile`. The renderer chooses
 * the provider type up front (the dialog title and the persisted
 * `provider_auth.provider` column both reflect this value); main
 * then opens `dialog.showOpenDialog` and reads the file itself, so
 * no file path or file content ever crosses the IPC boundary
 * (design.md §Layered Trust Model + Requirement 8.1).
 */
export const importProviderAuthFileInputSchema = z
  .object({
    provider: providerIdSchema,
  })
  .strict();

/**
 * Input for `desktop:deleteProviderAuth`. The single-field shape
 * mirrors the repository's `remove(id)` signature; the handler
 * tolerates an unknown id (idempotent removal — Requirement 9.5).
 */
export const deleteProviderAuthInputSchema = z
  .object({
    id: trimmedNonEmpty,
  })
  .strict();

/**
 * Input for `desktop:refreshProviderQuota`. Either field may be
 * omitted: an empty payload triggers a global refresh, `id` scopes
 * to a single `provider_auth` row, and `provider` scopes to every
 * row for the given provider. The fields are not mutually exclusive
 * — when both are supplied the handler narrows to the row matching
 * both (the per-account 5-minute throttle still applies regardless).
 *
 * `id` is `z.string().optional()` rather than `trimmedNonEmpty` so
 * `{ id: undefined }` is accepted exactly like `{}`. The handler
 * treats blank strings as "no id" defensively before forwarding to
 * the service.
 */
export const refreshProviderQuotaInputSchema = z
  .object({
    id: z.string().optional(),
    provider: providerIdSchema.optional(),
  })
  .strict();

/**
 * Input for `desktop:validateProviderAuth`. Lightweight validation
 * runs entirely on the locally stored Secret Payload — no upstream
 * call is issued in v1 (design.md §validateLightweight) — so a
 * valid `id` is the only thing the handler needs.
 */
export const validateProviderAuthInputSchema = z
  .object({
    id: trimmedNonEmpty,
  })
  .strict();

/**
 * Input for `desktop:createProviderAuthApiKey`. The renderer collects
 * the API-key + (optional) base URL from a manual entry form and
 * the service shapes them into a {@link ProviderAuthSecretPayload}
 * before encrypting. Only API-key providers (`gemini-api`,
 * `deepseek`, `xiaomi`, `openai-compatible`) accept this entry —
 * OAuth providers must come in via `importProviderAuthFile`.
 *
 * Validation rules:
 *   - `provider` is restricted to the manual-API-key subset. Other
 *     `ProviderId` values fail at the schema layer with a closed
 *     enum mismatch.
 *   - `apiKey` is `trimmedNonEmpty` so a whitespace-only value is
 *     rejected before the secret store ever sees it.
 *   - `label` is optional; when absent the service generates a
 *     provider-specific default (`Gemini API key` etc.).
 *   - `baseUrl`, when present, must parse as an http(s) URL. The
 *     handler additionally requires `baseUrl` for
 *     `'openai-compatible'` (the schema cannot encode that
 *     conditional without a `superRefine` that depends on the
 *     `provider` field, so the service double-checks).
 */
export const manualApiKeyProviderSchema = z.enum([
  'gemini-api',
  'deepseek',
  'xiaomi',
  'opencode',
  'openai-compatible',
]);

const optionalBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .url()
  .refine(
    (v) => v.startsWith('http://') || v.startsWith('https://'),
    'baseUrl must be http(s)://',
  )
  .optional();

export const createProviderAuthApiKeyInputSchema = z
  .object({
    provider: manualApiKeyProviderSchema,
    label: z.string().trim().min(1).max(120).optional(),
    // `apiKey` is required for every manual-API-key provider EXCEPT
    // `xiaomi` and `opencode`, which authenticate via cookies. The
    // cross-field check below enforces the per-provider rules in
    // one place.
    apiKey: z.string().trim().min(1).optional(),
    baseUrl: optionalBaseUrlSchema,
    xiaomiPassToken: z.string().trim().min(1).optional(),
    xiaomiUserId: z.string().trim().min(1).optional(),
    deepseekUserToken: z.string().trim().min(1).optional(),
    opencodeAuthCookie: z.string().trim().min(1).optional(),
    opencodeWorkspaceUrl: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.provider === 'xiaomi') {
      // Xiaomi requires the cookie pair, NOT an API key.
      if (!input.xiaomiPassToken) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['xiaomiPassToken'],
          message: 'xiaomiPassToken is required for xiaomi accounts',
        });
      }
      if (!input.xiaomiUserId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['xiaomiUserId'],
          message: 'xiaomiUserId is required for xiaomi accounts',
        });
      }
    } else if (input.provider === 'opencode') {
      // OpenCode Go uses an opaque Iron-encrypted `auth` cookie
      // value plus a workspace dashboard URL. Both fields are
      // required: the URL identifies the workspace (each user has
      // their own `wrk_<id>`) and the cookie authenticates the
      // SSR HTML fetch. opencode.ai has no public REST surface
      // that returns Go usage, so we keep scraping the dashboard.
      if (!input.opencodeAuthCookie) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['opencodeAuthCookie'],
          message: 'opencodeAuthCookie is required for opencode accounts',
        });
      }
      if (!input.opencodeWorkspaceUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['opencodeWorkspaceUrl'],
          message: 'opencodeWorkspaceUrl is required for opencode accounts',
        });
      }
    } else {
      if (!input.apiKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['apiKey'],
          message: 'apiKey is required for this provider',
        });
      }
      if (input.provider === 'openai-compatible' && !input.baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrl'],
          message: 'baseUrl is required for openai-compatible accounts',
        });
      }
    }
  });

/**
 * Input for `desktop:setProviderAuthEnabled`. Idempotent on a
 * missing id (the handler returns `null`); the schema only checks
 * the shape.
 */
export const setProviderAuthEnabledInputSchema = z
  .object({
    id: trimmedNonEmpty,
    enabled: z.boolean(),
  })
  .strict();

/**
 * Result envelope for `desktop:validateProviderAuth`. `ok` is a
 * direct boolean rather than the `IpcResult` discriminator because
 * a "validation failed" outcome is a normal, non-exceptional answer
 * — it carries a `ProviderAuthErrorCode` so the renderer can render
 * the appropriate Chinese copy without parsing the message string.
 *
 * `code` widens to `'ok' | ProviderAuthErrorCode` so the success
 * case has a stable, structured value the renderer can switch on
 * (design.md §`ProviderAuthValidationResult`).
 *
 * `message` is bounded at 80 characters to match the pre-redaction
 * rule in `provider_auth.service` and the same bound on
 * `ProviderAuthMetadata.lastErrorMessage`.
 */
export const providerAuthValidationResultSchema = z
  .object({
    ok: z.boolean(),
    code: z.union([providerAuthErrorCodeSchema, z.literal('ok')]),
    message: z.string().max(80),
  })
  .strict();

// ---------------------------------------------------------------------------
// Push channel schemas
// ---------------------------------------------------------------------------

export const desktopPushChannelSchema = z.enum([
  'dashboard.updated',
  'openclash.updated',
  'navigate-tab',
  'settings.updated',
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
      snapshots: z.array(quotaSnapshotSchema),
    }),
  },
  resizeCompactWindow: {
    input: resizeCompactWindowInputSchema,
    output: z.void(),
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
  // CPA quota import (cpa-quota-import spec, task 10.2). Each
  // channel rejects malformed payloads at the IPC boundary with
  // `{ ok: false, error: { code: 'validation', ... } }` before the
  // underlying service is invoked (Requirement 9.6).
  //
  // `refreshProviderQuota` reuses the same `QuotaStatus` envelope
  // returned by `getQuotaStatus` so the renderer's rendering code
  // path stays single-sourced (design.md §IPC channels and
  // schemas).
  listProviderAuths: {
    input: emptyInputSchema,
    output: z.array(providerAuthMetadataSchema),
  },
  importProviderAuthFile: {
    input: importProviderAuthFileInputSchema,
    output: providerAuthMetadataSchema,
  },
  deleteProviderAuth: {
    input: deleteProviderAuthInputSchema,
    output: z.void(),
  },
  refreshProviderQuota: {
    input: refreshProviderQuotaInputSchema,
    output: z.object({
      snapshots: z.array(quotaSnapshotSchema),
    }),
  },
  validateProviderAuth: {
    input: validateProviderAuthInputSchema,
    output: providerAuthValidationResultSchema,
  },
  createProviderAuthApiKey: {
    input: createProviderAuthApiKeyInputSchema,
    output: providerAuthMetadataSchema,
  },
  setProviderAuthEnabled: {
    input: setProviderAuthEnabledInputSchema,
    output: providerAuthMetadataSchema.nullable(),
  },
} as const;

export type DesktopApiMethod = keyof typeof desktopApiSchemas;
