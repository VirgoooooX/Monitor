// Renderer-side type re-exports.
//
// The renderer must NOT runtime-import from `src/main` (preload / sandbox
// boundary). `import type` plus `isolatedModules: true` guarantees these
// declarations are erased at build time — Vite never bundles main code
// into the renderer chunk, and `electron`/`node` modules can never reach
// the sandbox.
//
// Source of truth for these shapes lives in `src/main/types.ts`
// (design.md §Data Models, §IPC Handler Registry).
//
// `Locale_Code` is the lone exception: its source of truth lives in
// `src/i18n/index.ts` (the only directory both processes are allowed
// to share at runtime, per i18n-multilingual-support/design.md
// §Architecture). The type-only re-export below keeps renderer
// imports of the locale union pointing at `lib/types` so call sites
// stay unchanged across the i18n rollout.
export type { Locale_Code } from '../../i18n';

export type {
  // Health
  HealthStatus,
  HealthInputs,
  ProbeResult,
  ProbeResultDigest,

  // OpenClash
  ConfigsResponse,
  ProxyEntry,
  ProxyHistoryEntry,
  ProxiesResponse,
  DelayResult,
  TrafficSnapshot,

  // Switching
  SwitchErrorCode,
  SwitchNodeResult,
  SwitchNodeInput,

  // Network Quick Actions
  ManagementErrorCode,
  QuickNodeCandidate,
  NetworkQuickActions,
  ConfigSwitchResult,
  SwitchOpenClashConfigInput,

  // Capability detection
  CapabilityResult,

  // Dashboard / details
  DashboardState,
  GroupView,
  NodeView,
  OpenClashDetails,

  // Usage
  UsageRange,
  CollectorStatus,
  UsageProviderSummary,
  UsageSummary,
  UsageSummaryInput,
  UsageTimeseriesBucket,
  ApiUsageSummary,
  ApiUsageBucket,
  ApiUsageNotice,

  // Quota
  QuotaWindow,
  QuotaSnapshot,
  DailyUsagePoint,
  QuotaStatus,
  QuotaSource,
  QuotaKind,
  QuotaStatus2,

  // CPA Quota Import / Provider Auth (Foundation Phase)
  // NOTE: `ProviderAuthSecretPayload` is intentionally NOT re-exported
  // here — the renderer must never see secret material, and omitting
  // it from the mirror enforces that at compile time (design.md
  // §Layered Trust Model, requirements.md §1.4).
  ProviderId,
  QuotaCapability,
  ProviderAuthMetadata,
  ProviderAuthErrorCode,
  ManualApiKeyProvider,
  CreateProviderAuthApiKeyInput,
  SetProviderAuthEnabledInput,

  // Settings
  RouterHealthSettings,
  RefreshIntervalSettings,
  CollectorToggle,
  CliProxySettings,
  AppSettings,
  AppearanceSettings,
  ColorMode,
  CompactTheme,
  ManagementInterfaceSettings,
  ManagementConfigFileEntry,
  KiroTokenRefreshSettings,

  // Diagnostics
  CollectorHealthRow,
  DiagnosticsReport,
  ProviderAuthDiagnosticsEntry,

  // IPC contract
  DesktopApi,
  DesktopPushChannel,
  DesktopPushPayloads,
  Unsubscribe,
  IpcError,
  IpcResult,
} from '../../main/types';
