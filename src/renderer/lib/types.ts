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

  // Quota
  QuotaWindow,
  QuotaSnapshot,
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
