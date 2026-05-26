// Preload bridge.
//
// This script runs in Electron's preload context: it has access to
// `ipcRenderer` and `contextBridge` but executes inside a sandboxed
// Chromium process with `contextIsolation: true` (see
// `windows.ts#SECURE_WEB_PREFERENCES`). The only object it exposes to
// the renderer is `window.desktop`, a typed `DesktopApi` surface
// (design.md §IPC Handler Registry, §Layered Trust Model).
//
// Trust model:
//   - Renderer is untrusted. Any value received from the renderer
//     (channel name in `on`, payload in `invoke` arguments) must be
//     treated as adversarial. We whitelist channel names against the
//     static registry in `../main/ipc/channels.ts`.
//   - We never pass `ipcRenderer` (or any other Electron primitive)
//     across `contextBridge`. The exposed object is plain functions
//     plus simple data — `contextBridge` enforces this and would
//     throw on a non-clonable value, but stating the rule explicitly
//     keeps future edits honest.
//   - All return values are forwarded as-is from `ipcRenderer.invoke`.
//     Output validation is the renderer's responsibility (zod schemas
//     live in `../main/schemas.ts` and are intended for the main side
//     of the IPC boundary, where rejecting bad inputs early matters
//     most — Property 12).

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  DESKTOP_INVOKE_CHANNELS,
  isDesktopPushChannel,
} from '../main/ipc/channels';
import type {
  AppSettings,
  ConfigSwitchResult,
  DashboardState,
  DesktopApi,
  DesktopPushChannel,
  DesktopPushPayloads,
  DiagnosticsReport,
  IpcResult,
  NetworkQuickActions,
  OpenClashDetails,
  QuotaStatus,
  SwitchNodeInput,
  SwitchNodeResult,
  SwitchOpenClashConfigInput,
  Unsubscribe,
  UpdateSecretInput,
  UsageSummary,
  UsageSummaryInput,
} from '../main/types';

// ---------------------------------------------------------------------------
// Envelope unwrapping
// ---------------------------------------------------------------------------

/**
 * Error class used to surface main-side IPC failures into the
 * renderer's typed `Promise<T>` API. The renderer-facing `DesktopApi`
 * methods return unwrapped values; on the wire we always carry a
 * structured `IpcResult<T>` envelope (design.md §`ipc.ts`,
 * §Property 12). This class is the bridge: a `{ ok: false, error }`
 * envelope is rejected as a real `Error` instance carrying the same
 * `code` and `message` so renderer code can `try/catch` on it.
 *
 * Exposed to the renderer purely as a thrown value — the prototype
 * chain is preserved across `contextBridge` because the error is
 * constructed inside the preload context (which shares its V8
 * isolate with the renderer for non-`require` purposes).
 */
class IpcEnvelopeError extends Error {
  public override readonly name = 'IpcEnvelopeError';
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Type guard for the envelope returned by every `ipcMain.handle`
 * registered in `src/main/ipc/index.ts`. We treat anything that does
 * not match as a malformed envelope and surface an `unknown` error so
 * the call site never silently resolves with a non-typed value.
 */
function isIpcResult<T>(value: unknown): value is IpcResult<T> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const ok = (value as { ok?: unknown }).ok;
  if (ok === true) {
    return 'value' in (value as Record<string, unknown>);
  }
  if (ok === false) {
    const err = (value as { error?: unknown }).error;
    if (err === null || typeof err !== 'object') {
      return false;
    }
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    return typeof code === 'string' && typeof message === 'string';
  }
  return false;
}

/**
 * Wrap an `ipcRenderer.invoke` call so that the call site reads as a
 * single typed expression. The handler always returns
 * `Promise<IpcResult<T>>`; this helper unwraps the envelope into the
 * renderer's `Promise<T>` shape — resolving with `result.value` on
 * success and rejecting with an {@link IpcEnvelopeError} otherwise.
 *
 * Output validation is the renderer's responsibility (design.md
 * §Property 12 only mandates main-side validation of *inputs*); we
 * trust the main side to produce a well-formed envelope and surface a
 * generic protocol error if anything else comes back.
 */
async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const raw = (await ipcRenderer.invoke(channel, payload)) as unknown;
  if (!isIpcResult<T>(raw)) {
    throw new IpcEnvelopeError(
      'protocol',
      `desktop.invoke: malformed envelope from '${channel}'`,
    );
  }
  if (raw.ok === true) {
    return raw.value;
  }
  throw new IpcEnvelopeError(raw.error.code, raw.error.message);
}

/**
 * Subscribe to a main-process push channel. Returns an
 * {@link Unsubscribe} that detaches exactly the listener installed
 * here — important because we may be invoked many times for the same
 * channel and we must never remove a listener that belongs to a
 * different subscriber.
 *
 * The supplied callback only sees the payload; the
 * `IpcRendererEvent` is stripped so the renderer never gets a
 * reference to a `Sender` or any other privileged Electron object.
 */
function subscribe<C extends DesktopPushChannel>(
  channel: C,
  cb: (payload: DesktopPushPayloads[C]) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => {
    cb(payload as DesktopPushPayloads[C]);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// ---------------------------------------------------------------------------
// `DesktopApi` implementation
// ---------------------------------------------------------------------------

const desktopApi: DesktopApi = {
  getDashboard(): Promise<DashboardState> {
    return invoke<DashboardState>(DESKTOP_INVOKE_CHANNELS.getDashboard);
  },

  getOpenClashDetails(): Promise<OpenClashDetails> {
    return invoke<OpenClashDetails>(
      DESKTOP_INVOKE_CHANNELS.getOpenClashDetails,
    );
  },

  switchNode(input: SwitchNodeInput): Promise<SwitchNodeResult> {
    return invoke<SwitchNodeResult>(
      DESKTOP_INVOKE_CHANNELS.switchNode,
      input,
    );
  },

  refreshNow(): Promise<void> {
    return invoke<void>(DESKTOP_INVOKE_CHANNELS.refreshNow);
  },

  getUsageSummary(input: UsageSummaryInput): Promise<UsageSummary> {
    return invoke<UsageSummary>(
      DESKTOP_INVOKE_CHANNELS.getUsageSummary,
      input,
    );
  },

  getQuotaStatus(): Promise<QuotaStatus> {
    return invoke<QuotaStatus>(DESKTOP_INVOKE_CHANNELS.getQuotaStatus);
  },

  getSettings(): Promise<AppSettings> {
    return invoke<AppSettings>(DESKTOP_INVOKE_CHANNELS.getSettings);
  },

  updateSettings(input: Partial<AppSettings>): Promise<AppSettings> {
    return invoke<AppSettings>(
      DESKTOP_INVOKE_CHANNELS.updateSettings,
      input,
    );
  },

  updateSecret(input: UpdateSecretInput): Promise<void> {
    return invoke<void>(DESKTOP_INVOKE_CHANNELS.updateSecret, input);
  },

  getDiagnostics(): Promise<DiagnosticsReport> {
    return invoke<DiagnosticsReport>(DESKTOP_INVOKE_CHANNELS.getDiagnostics);
  },

  openExpanded(): Promise<void> {
    return invoke<void>(DESKTOP_INVOKE_CHANNELS.openExpanded);
  },

  // -------------------------------------------------------------------------
  // Network Quick Actions (network-quick-actions task 14.1)
  // -------------------------------------------------------------------------
  //
  // The three channels below back the expanded window's Quick Actions
  // panel. Each one follows the same envelope-unwrapping contract as
  // every other invoke method on this bridge — `invoke<T>()` rejects
  // with an `IpcEnvelopeError` carrying `error.code` / `error.message`
  // when the main-side handler returns `{ ok: false, ... }`.
  //
  // Channel-name whitelisting is implicit: `DESKTOP_INVOKE_CHANNELS`
  // is the single source of truth for both the preload bridge and the
  // main-process handler registry (see
  // `src/main/ipc/channels.ts`). Drift between the two sides is a
  // compile error because the registry is keyed by the same
  // `DesktopInvokeMethod` union the bridge consumes here.

  getNetworkQuickActions(): Promise<NetworkQuickActions> {
    return invoke<NetworkQuickActions>(
      DESKTOP_INVOKE_CHANNELS.getNetworkQuickActions,
    );
  },

  switchOpenClashConfig(
    input: SwitchOpenClashConfigInput,
  ): Promise<ConfigSwitchResult> {
    return invoke<ConfigSwitchResult>(
      DESKTOP_INVOKE_CHANNELS.switchOpenClashConfig,
      input,
    );
  },

  clearManagementCredentials(): Promise<void> {
    return invoke<void>(
      DESKTOP_INVOKE_CHANNELS.clearManagementCredentials,
    );
  },

  on<C extends DesktopPushChannel>(
    channel: C,
    cb: (payload: DesktopPushPayloads[C]) => void,
  ): Unsubscribe {
    // Whitelist the channel name against the static registry. Even
    // though the parameter is typed as `DesktopPushChannel`, the
    // renderer ultimately controls the value at runtime, so we
    // must validate.
    if (!isDesktopPushChannel(channel)) {
      throw new Error(
        `desktop.on: unsupported channel '${String(channel)}'`,
      );
    }
    if (typeof cb !== 'function') {
      throw new TypeError('desktop.on: callback must be a function');
    }
    return subscribe(channel, cb);
  },
};

// `exposeInMainWorld` clones plain values into the renderer realm and
// proxies functions across the context bridge. The object literal
// above contains only methods plus simple types, so the clone path
// is well-defined; passing `ipcRenderer` directly would be rejected
// by `contextBridge` and is forbidden by our trust model anyway.
contextBridge.exposeInMainWorld('desktop', desktopApi);
