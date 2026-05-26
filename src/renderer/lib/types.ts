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

  // Settings
  RouterHealthSettings,
  RefreshIntervalSettings,
  CollectorToggle,
  AppSettings,

  // Diagnostics
  CollectorHealthRow,
  DiagnosticsReport,

  // IPC contract
  DesktopApi,
  DesktopPushChannel,
  DesktopPushPayloads,
  Unsubscribe,
  IpcError,
  IpcResult,
} from '../../main/types';
