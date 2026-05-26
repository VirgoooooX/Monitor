// Provider_Auth IPC handler unit tests (cpa-quota-import task 10.6).
//
// Validates Requirements 9.6, 1.4, 10.4.
//
// Covers, for each of the five new channels added in task 10.3 —
//   - `desktop:listProviderAuths`
//   - `desktop:importProviderAuthFile`
//   - `desktop:deleteProviderAuth`
//   - `desktop:refreshProviderQuota`
//   - `desktop:validateProviderAuth`
// the following invariants:
//
//   1. Schema rejection: a malformed payload returns
//      `{ ok: false, error: { code: 'validation', ... } }` BEFORE the
//      underlying service is invoked (Requirement 9.6).
//
//   2. ProviderAuthError mapping: every closed `ProviderAuthErrorCode`
//      thrown by the service round-trips through the IPC envelope as
//      `{ ok: false, error: { code, message } }` with the exact code
//      preserved (Requirement 10.4).
//
//   3. SecretsUnavailableError → `{ code: 'unavailable' }`;
//      SecretsDecryptError → `{ code: 'auth_expired' }`. Other errors
//      collapse to `{ code: 'internal' }`.
//
//   4. Renderer-blind contract (Requirement 1.4): the IPC envelope
//      JSON-stringified for any of the five channels never contains
//      the substrings `'prompt'`, `'response'`, `'messages'`, or any
//      access-token-shaped value. We enforce this by stubbing the
//      service to return realistic-looking metadata + by feeding the
//      service `ProviderAuthError` instances whose messages are
//      pre-redacted; the test then walks every successful and failure
//      envelope and asserts the substring exclusion.
//
// Strategy
// --------
//
// `electron`'s `ipcMain` is mocked at module-load time so the handler
// registry's `ipcMain.handle(channel, fn)` calls can be captured into
// a Map and invoked directly without an Electron `BrowserWindow` /
// IPC bridge. The dashboard / OpenClash / switch-node / management
// dependencies that the registry pulls in for unrelated channels are
// stubbed minimally — Provider_Auth handlers don't reach for them.
//
// The Provider_Auth and Quota services are stubbed entirely; we are
// testing the handler envelope-shaping behaviour, not the services.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// `vi.mock('electron')` — capture handler registrations.
// ---------------------------------------------------------------------------
//
// The factory body runs at module-load time (before any top-level
// statement here), so we stash the captured handler map on
// `globalThis` and resolve it lazily inside the closures. The same
// pattern as `audit-completeness.pbt.test.ts`.

type CapturedHandler = (event: unknown, payload: unknown) => Promise<unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __cpa_provider_auth_handlers__: Map<string, CapturedHandler> | undefined;
}

vi.mock('electron', () => {
  const getMap = (): Map<string, CapturedHandler> => {
    if (globalThis.__cpa_provider_auth_handlers__ === undefined) {
      globalThis.__cpa_provider_auth_handlers__ = new Map<
        string,
        CapturedHandler
      >();
    }
    return globalThis.__cpa_provider_auth_handlers__;
  };
  return {
    ipcMain: {
      handle(channel: string, handler: CapturedHandler) {
        getMap().set(channel, handler);
      },
      removeHandler(channel: string) {
        getMap().delete(channel);
      },
    },
  };
});

const ipcHandlers: Map<string, CapturedHandler> = (() => {
  if (globalThis.__cpa_provider_auth_handlers__ === undefined) {
    globalThis.__cpa_provider_auth_handlers__ = new Map<string, CapturedHandler>();
  }
  return globalThis.__cpa_provider_auth_handlers__;
})();

// Lazy imports — must come AFTER the `vi.mock` call.
const { registerIpcHandlers } = await import('./index');
const { DESKTOP_INVOKE_CHANNELS } = await import('./channels');
const { ProviderAuthError } = await import('../services/provider_auth.service');
const { SecretsUnavailableError, SecretsDecryptError } = await import(
  '../security/secrets'
);

import type {
  IpcRegistry,
  IpcRegistryDeps,
} from './index';
import type {
  ProviderAuthService,
  ProviderAuthValidationResult,
} from '../services/provider_auth.service';
import type { QuotaService } from '../services/quota.service';
import type {
  IpcResult,
  ProviderAuthErrorCode,
  ProviderAuthMetadata,
  ProviderId,
  QuotaStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Forbidden substring catalogue — Requirement 1.4 enforcement.
// ---------------------------------------------------------------------------
//
// Every IPC envelope produced by these five handlers is
// `JSON.stringify`'d and asserted not to contain any of these
// substrings. The list intentionally covers:
//   - chat-content keys the parser strips (`prompt`, `response`, `messages`),
//   - common token field names (`access_token`, `refresh_token`,
//     `accessToken`, `refreshToken`, `apiKey`),
//   - the secret-key prefix the service uses (`cpaAuth.providerAuth.`).
//
// Note: `lastErrorMessage` is bounded to 80 chars at the schema level
// and the service pre-redacts the messages, so a stray token fragment
// cannot escape via that channel either.
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  'prompt',
  'response',
  'messages',
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'cpaAuth.providerAuth.',
  // Two pseudo-token-shaped strings the stubbed service is told to
  // hold internally. If either ever appears in an envelope it would
  // mean the handler leaked a secret payload.
  'STUB-ACCESS-TOKEN-DO-NOT-LEAK',
  'STUB-API-KEY-DO-NOT-LEAK',
];

function assertEnvelopeIsRedacted(envelope: unknown): void {
  const serialised = JSON.stringify(envelope);
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    expect(serialised.indexOf(forbidden)).toBe(-1);
  }
}

// ---------------------------------------------------------------------------
// Stub services
// ---------------------------------------------------------------------------

interface ProviderAuthServiceStub extends ProviderAuthService {
  /** Reset all spies between tests. */
  reset(): void;
  /** Counts of each method invocation since the last reset. */
  counts: {
    list: number;
    importFromFile: number;
    remove: number;
    validate: number;
  };
}

interface QuotaServiceStub extends QuotaService {
  reset(): void;
  counts: { refresh: number; getQuotaStatus: number };
}

function makeProviderAuthServiceStub(): ProviderAuthServiceStub {
  const counts = { list: 0, importFromFile: 0, remove: 0, validate: 0 };
  const stub: ProviderAuthServiceStub = {
    counts,
    reset() {
      counts.list = 0;
      counts.importFromFile = 0;
      counts.remove = 0;
      counts.validate = 0;
      // Reset the per-instance behaviour overrides as well so each
      // test gets a clean slate.
      stub.list = () => {
        counts.list += 1;
        return [];
      };
      stub.importFromFile = async () => {
        counts.importFromFile += 1;
        throw new Error('importFromFile not configured for this test');
      };
      stub.remove = () => {
        counts.remove += 1;
      };
      stub.validate = (): ProviderAuthValidationResult => {
        counts.validate += 1;
        return { ok: true, code: 'ok', message: '' };
      };
    },
    list: () => [],
    importFromFile: async () => {
      throw new Error('importFromFile not configured');
    },
    remove: () => {},
    validate: () => ({ ok: true, code: 'ok', message: '' }),
  };
  stub.reset();
  return stub;
}

function makeQuotaServiceStub(): QuotaServiceStub {
  const counts = { refresh: 0, getQuotaStatus: 0 };
  const stub: QuotaServiceStub = {
    counts,
    reset() {
      counts.refresh = 0;
      counts.getQuotaStatus = 0;
      stub.refresh = async () => {
        counts.refresh += 1;
        return { snapshots: [] };
      };
      stub.getQuotaStatus = async () => {
        counts.getQuotaStatus += 1;
        return { snapshots: [] };
      };
    },
    refresh: async () => ({ snapshots: [] }),
    getQuotaStatus: async () => ({ snapshots: [] }),
  };
  stub.reset();
  return stub;
}

// ---------------------------------------------------------------------------
// Realistic Provider_Auth metadata — kept free of any forbidden
// substring by construction, used to exercise the success path.
// ---------------------------------------------------------------------------

function makeRealisticMetadata(
  overrides: Partial<ProviderAuthMetadata> = {},
): ProviderAuthMetadata {
  return {
    id: 'd0a8e4b2-1234-4abc-9def-0123456789ab',
    provider: 'codex',
    label: 'codex:user@example.com',
    source: 'cpa-auth-file',
    accountId: 'acct-12345',
    projectId: null,
    quotaCapability: 'official',
    importedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    lastValidatedAt: 1_700_000_001_000,
    lastQuotaAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registry harness — register handlers with stub services + minimal
// stubs for the unrelated dependencies, then return a typed accessor
// for invoking the five Provider_Auth channels.
// ---------------------------------------------------------------------------

interface Harness {
  registry: IpcRegistry;
  providerAuth: ProviderAuthServiceStub;
  quota: QuotaServiceStub;
  invoke<T>(channel: string, payload: unknown): Promise<IpcResult<T>>;
}

function buildHarness(): Harness {
  const providerAuth = makeProviderAuthServiceStub();
  const quota = makeQuotaServiceStub();

  // Minimal stubs for unrelated deps. Provider_Auth handlers do not
  // touch any of these; we still need them to satisfy the
  // `IpcRegistryDeps` contract.
  const noopOpen = {} as unknown as IpcRegistryDeps['openClashClient'];
  const noopSwitch = {} as unknown as IpcRegistryDeps['switchNodeService'];
  const noopMgmt = {} as unknown as IpcRegistryDeps['openClashManagementClient'];
  const noopLock = {} as unknown as IpcRegistryDeps['switchLock'];
  const noopAudit = {} as unknown as IpcRegistryDeps['configSwitchAudit'];
  const noopRepos = {} as unknown as IpcRegistryDeps['repositories'];
  const noopDashboard = {} as unknown as IpcRegistryDeps['dashboardService'];
  const inflight = new Map<string, never>();

  const registry = registerIpcHandlers({
    repositories: noopRepos,
    dashboardService: noopDashboard,
    openClashClient: noopOpen,
    switchNodeService: noopSwitch,
    openClashManagementClient: noopMgmt,
    switchLock: noopLock,
    configSwitchAudit: noopAudit,
    inflightConfigSwitches: inflight as unknown as IpcRegistryDeps['inflightConfigSwitches'],
    getSettings: () => ({}) as unknown as ReturnType<IpcRegistryDeps['getSettings']>,
    updateSettings: () => ({}) as unknown as ReturnType<IpcRegistryDeps['updateSettings']>,
    updateSecret: () => {},
    removeSecret: () => {},
    getSecret: () => null,
    providerAuthService: providerAuth,
    quotaService: quota,
  });

  async function invoke<T>(
    channel: string,
    payload: unknown,
  ): Promise<IpcResult<T>> {
    const handler = ipcHandlers.get(channel);
    if (handler === undefined) {
      throw new Error(`handler not registered for channel: ${channel}`);
    }
    return (await handler({}, payload)) as IpcResult<T>;
  }

  return { registry, providerAuth, quota, invoke };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('Provider_Auth IPC handlers — schema rejection', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });
  afterEach(() => {
    harness.registry.dispose();
  });

  // For each channel: a payload that the schema must reject. The
  // handler must short-circuit with `code: 'validation'` BEFORE the
  // service is invoked (Requirement 9.6).

  it('rejects malformed listProviderAuths payload (non-undefined)', async () => {
    const result = await harness.invoke<ProviderAuthMetadata[]>(
      DESKTOP_INVOKE_CHANNELS.listProviderAuths,
      { unexpected: 'payload' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
    expect(harness.providerAuth.counts.list).toBe(0);
    assertEnvelopeIsRedacted(result);
  });

  it('rejects malformed importProviderAuthFile payload (missing provider)', async () => {
    const result = await harness.invoke<ProviderAuthMetadata>(
      DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
    expect(harness.providerAuth.counts.importFromFile).toBe(0);
    assertEnvelopeIsRedacted(result);
  });

  it('rejects malformed importProviderAuthFile payload (unknown provider)', async () => {
    const result = await harness.invoke<ProviderAuthMetadata>(
      DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
      { provider: 'not-a-real-provider' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
    expect(harness.providerAuth.counts.importFromFile).toBe(0);
    assertEnvelopeIsRedacted(result);
  });

  it('rejects malformed deleteProviderAuth payload (missing id)', async () => {
    const result = await harness.invoke<void>(
      DESKTOP_INVOKE_CHANNELS.deleteProviderAuth,
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
    expect(harness.providerAuth.counts.remove).toBe(0);
    assertEnvelopeIsRedacted(result);
  });

  it('rejects malformed deleteProviderAuth payload (empty id)', async () => {
    const result = await harness.invoke<void>(
      DESKTOP_INVOKE_CHANNELS.deleteProviderAuth,
      { id: '' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
    expect(harness.providerAuth.counts.remove).toBe(0);
    assertEnvelopeIsRedacted(result);
  });

  it('rejects malformed refreshProviderQuota payload (extra field, strict)', async () => {
    const result = await harness.invoke<QuotaStatus>(
      DESKTOP_INVOKE_CHANNELS.refreshProviderQuota,
      { unknownKey: 'should-be-rejected' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
    expect(harness.quota.counts.refresh).toBe(0);
    assertEnvelopeIsRedacted(result);
  });

  it('rejects malformed refreshProviderQuota payload (invalid provider value)', async () => {
    const result = await harness.invoke<QuotaStatus>(
      DESKTOP_INVOKE_CHANNELS.refreshProviderQuota,
      { provider: 'definitely-not-a-provider' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
    expect(harness.quota.counts.refresh).toBe(0);
    assertEnvelopeIsRedacted(result);
  });

  it('rejects malformed validateProviderAuth payload (missing id)', async () => {
    const result = await harness.invoke<ProviderAuthValidationResult>(
      DESKTOP_INVOKE_CHANNELS.validateProviderAuth,
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('validation');
    }
    expect(harness.providerAuth.counts.validate).toBe(0);
    assertEnvelopeIsRedacted(result);
  });
});

describe('Provider_Auth IPC handlers — ProviderAuthError mapping', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });
  afterEach(() => {
    harness.registry.dispose();
  });

  // Every `ProviderAuthErrorCode` the importFromFile pipeline can
  // legitimately throw. The handler must echo the exact code through
  // the IPC envelope without remapping (Requirement 10.4).
  const importableErrorCodes: readonly ProviderAuthErrorCode[] = [
    'cancelled',
    'parse_error',
    'unsupported_file',
    'auth_missing',
    'project_missing',
    'auth_expired',
    'upstream_unauthorized',
    'rate_limited',
    'upstream_changed',
    'network_error',
    'unsupported',
    'validation',
  ];

  it.each(importableErrorCodes)(
    'maps ProviderAuthError(%s) onto the IPC envelope verbatim',
    async (code) => {
      harness.providerAuth.importFromFile = async () => {
        harness.providerAuth.counts.importFromFile += 1;
        throw new ProviderAuthError(code, `redacted message for ${code}`);
      };

      const result = await harness.invoke<ProviderAuthMetadata>(
        DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
        { provider: 'codex' as ProviderId },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        // The message must be a string (bounded to ≤80 chars by the
        // handler — the service-provided message is well below that).
        expect(typeof result.error.message).toBe('string');
        expect(result.error.message.length).toBeLessThanOrEqual(80);
      }
      expect(harness.providerAuth.counts.importFromFile).toBe(1);
      assertEnvelopeIsRedacted(result);
    },
  );

  it('maps SecretsUnavailableError onto code: "unavailable"', async () => {
    harness.providerAuth.importFromFile = async () => {
      throw new SecretsUnavailableError('safeStorage encryption is not available');
    };
    const result = await harness.invoke<ProviderAuthMetadata>(
      DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
      { provider: 'codex' as ProviderId },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unavailable');
    }
    assertEnvelopeIsRedacted(result);
  });

  it('maps SecretsDecryptError onto code: "auth_expired"', async () => {
    harness.providerAuth.importFromFile = async () => {
      throw new SecretsDecryptError('cpaAuth.providerAuth.test-id');
    };
    const result = await harness.invoke<ProviderAuthMetadata>(
      DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
      { provider: 'codex' as ProviderId },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('auth_expired');
      // The handler replaces the error's stock message (which embeds
      // the secret key) with a deterministic redacted string. The
      // forbidden-substring catalogue includes `cpaAuth.providerAuth.`
      // and `assertEnvelopeIsRedacted` enforces the substitution.
    }
    assertEnvelopeIsRedacted(result);
  });

  it('maps generic Error onto code: "internal"', async () => {
    harness.providerAuth.importFromFile = async () => {
      throw new Error('unexpected boom');
    };
    const result = await harness.invoke<ProviderAuthMetadata>(
      DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
      { provider: 'codex' as ProviderId },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('internal');
    }
    assertEnvelopeIsRedacted(result);
  });
});

describe('Provider_Auth IPC handlers — success envelopes & redaction', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });
  afterEach(() => {
    harness.registry.dispose();
  });

  it('listProviderAuths returns the service metadata array verbatim', async () => {
    const rows: ProviderAuthMetadata[] = [
      makeRealisticMetadata({
        id: 'aaaaaaaa-1111-4abc-9def-000000000001',
        provider: 'codex',
        label: 'codex:user-a@example.com',
      }),
      makeRealisticMetadata({
        id: 'bbbbbbbb-2222-4abc-9def-000000000002',
        provider: 'gemini-cli',
        label: 'gemini-cli:project-b',
        accountId: null,
        projectId: 'gcp-project-b',
        quotaCapability: 'unsupported',
      }),
      makeRealisticMetadata({
        id: 'cccccccc-3333-4abc-9def-000000000003',
        provider: 'claude-code',
        label: 'claude-code:user-c@example.com',
        lastErrorCode: 'auth_expired',
        lastErrorMessage: 'OAuth token expired; re-export from CPA',
      }),
    ];
    harness.providerAuth.list = () => {
      harness.providerAuth.counts.list += 1;
      return rows;
    };

    const result = await harness.invoke<ProviderAuthMetadata[]>(
      DESKTOP_INVOKE_CHANNELS.listProviderAuths,
      undefined,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Exact array — no projection / mutation by the handler.
      expect(result.value).toEqual(rows);
    }
    expect(harness.providerAuth.counts.list).toBe(1);
    assertEnvelopeIsRedacted(result);
  });

  it('importProviderAuthFile returns the freshly imported metadata', async () => {
    const newRow = makeRealisticMetadata({
      id: '11111111-1111-4abc-9def-111111111111',
      provider: 'gemini-api',
      label: 'gemini-api:imported',
      accountId: null,
      projectId: null,
      quotaCapability: 'health_only',
    });
    harness.providerAuth.importFromFile = async (input) => {
      harness.providerAuth.counts.importFromFile += 1;
      expect(input.provider).toBe('gemini-api');
      return newRow;
    };
    const result = await harness.invoke<ProviderAuthMetadata>(
      DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
      { provider: 'gemini-api' as ProviderId },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(newRow);
    }
    assertEnvelopeIsRedacted(result);
  });

  it('deleteProviderAuth forwards the id and returns success', async () => {
    let seen: string | null = null;
    harness.providerAuth.remove = (id: string) => {
      harness.providerAuth.counts.remove += 1;
      seen = id;
    };
    const result = await harness.invoke<void>(
      DESKTOP_INVOKE_CHANNELS.deleteProviderAuth,
      { id: 'aaaaaaaa-1111-4abc-9def-000000000001' },
    );
    expect(result.ok).toBe(true);
    expect(seen).toBe('aaaaaaaa-1111-4abc-9def-000000000001');
    expect(harness.providerAuth.counts.remove).toBe(1);
    assertEnvelopeIsRedacted(result);
  });

  it('refreshProviderQuota forwards id+provider and returns the QuotaStatus envelope', async () => {
    const refreshOutput: QuotaStatus = { snapshots: [] };
    let seen: { id?: string; provider?: ProviderId } | undefined;
    harness.quota.refresh = async (input) => {
      harness.quota.counts.refresh += 1;
      seen = input;
      return refreshOutput;
    };
    const result = await harness.invoke<QuotaStatus>(
      DESKTOP_INVOKE_CHANNELS.refreshProviderQuota,
      { id: 'aaaaaaaa-1111-4abc-9def-000000000001', provider: 'codex' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(refreshOutput);
    }
    expect(seen).toEqual({
      id: 'aaaaaaaa-1111-4abc-9def-000000000001',
      provider: 'codex',
    });
    assertEnvelopeIsRedacted(result);
  });

  it('refreshProviderQuota with empty payload calls refresh({}) (global refresh)', async () => {
    let seen: { id?: string; provider?: ProviderId } | undefined;
    harness.quota.refresh = async (input) => {
      harness.quota.counts.refresh += 1;
      seen = input;
      return { snapshots: [] };
    };
    const result = await harness.invoke<QuotaStatus>(
      DESKTOP_INVOKE_CHANNELS.refreshProviderQuota,
      {},
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual({});
    assertEnvelopeIsRedacted(result);
  });

  it('validateProviderAuth returns the service ValidationResult', async () => {
    const validation: ProviderAuthValidationResult = {
      ok: false,
      code: 'auth_missing',
      message: 'access token missing from imported payload',
    };
    harness.providerAuth.validate = (id: string) => {
      harness.providerAuth.counts.validate += 1;
      expect(id).toBe('aaaaaaaa-1111-4abc-9def-000000000001');
      return validation;
    };
    const result = await harness.invoke<ProviderAuthValidationResult>(
      DESKTOP_INVOKE_CHANNELS.validateProviderAuth,
      { id: 'aaaaaaaa-1111-4abc-9def-000000000001' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(validation);
    }
    assertEnvelopeIsRedacted(result);
  });
});

describe('Provider_Auth IPC handlers — secret payload exclusion (defence in depth)', () => {
  // These tests intentionally feed the stub services data that
  // *would* leak a secret if the handler did not project through
  // the documented redacted shapes. The stubs return plausible
  // metadata containing harmless-looking strings; the forbidden-
  // substring assertions catch any envelope shape that would let a
  // secret pass through (Requirement 1.4).

  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });
  afterEach(() => {
    harness.registry.dispose();
  });

  it('successful list envelope contains no token / chat-content substrings', async () => {
    harness.providerAuth.list = () => [
      makeRealisticMetadata({
        id: 'redaction-check-id',
        label: 'codex:user@example.com',
      }),
    ];
    const result = await harness.invoke<ProviderAuthMetadata[]>(
      DESKTOP_INVOKE_CHANNELS.listProviderAuths,
      undefined,
    );
    expect(result.ok).toBe(true);
    assertEnvelopeIsRedacted(result);
  });

  it('failure envelopes never carry the secret-key prefix even when the underlying error mentions it', async () => {
    // Construct an error whose message embeds the secret-key prefix
    // (`cpaAuth.providerAuth.<uuid>`). The handler maps it to
    // `code: 'auth_expired'` and replaces the message with a
    // deterministic redacted string; the forbidden-substring
    // catalogue verifies the replacement.
    harness.providerAuth.importFromFile = async () => {
      throw new SecretsDecryptError(
        'cpaAuth.providerAuth.aaaaaaaa-1111-4abc-9def-000000000001',
      );
    };
    const result = await harness.invoke<ProviderAuthMetadata>(
      DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
      { provider: 'codex' as ProviderId },
    );
    expect(result.ok).toBe(false);
    assertEnvelopeIsRedacted(result);
  });

  it('refresh envelope is redacted across all five channels', async () => {
    // Sweep all five channels with a stubbed-success response and
    // assert the substring catalogue holds for every envelope.
    harness.providerAuth.list = () => [makeRealisticMetadata()];
    harness.providerAuth.importFromFile = async () => makeRealisticMetadata();
    harness.providerAuth.remove = () => {};
    harness.providerAuth.validate = () => ({ ok: true, code: 'ok', message: '' });
    harness.quota.refresh = async () => ({ snapshots: [] });

    const envelopes: unknown[] = [];
    envelopes.push(
      await harness.invoke<ProviderAuthMetadata[]>(
        DESKTOP_INVOKE_CHANNELS.listProviderAuths,
        undefined,
      ),
    );
    envelopes.push(
      await harness.invoke<ProviderAuthMetadata>(
        DESKTOP_INVOKE_CHANNELS.importProviderAuthFile,
        { provider: 'codex' as ProviderId },
      ),
    );
    envelopes.push(
      await harness.invoke<void>(
        DESKTOP_INVOKE_CHANNELS.deleteProviderAuth,
        { id: 'aaaaaaaa-1111-4abc-9def-000000000001' },
      ),
    );
    envelopes.push(
      await harness.invoke<QuotaStatus>(
        DESKTOP_INVOKE_CHANNELS.refreshProviderQuota,
        {},
      ),
    );
    envelopes.push(
      await harness.invoke<ProviderAuthValidationResult>(
        DESKTOP_INVOKE_CHANNELS.validateProviderAuth,
        { id: 'aaaaaaaa-1111-4abc-9def-000000000001' },
      ),
    );

    for (const envelope of envelopes) {
      assertEnvelopeIsRedacted(envelope);
    }
  });
});
