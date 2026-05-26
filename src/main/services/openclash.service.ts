// OpenClash HTTP client.
//
// References:
//   - design.md §`openclash.service.ts` (interface contract)
//   - design.md §Switch Node With Verification (PUT semantics; verification
//     itself lives in task 3.5 — this module only ships the raw PUT helper)
//   - PLAN.md §OpenClash Service (URL shapes, default timeouts)
//
// Design choices encoded here:
//
// - **Live controllerUrl / secret**. Both are accepted as functions so that
//   user changes from the Settings view take effect on the very next request
//   without restarting the service. A plain string is also accepted and
//   normalised to a one-shot getter for ergonomic call sites.
// - **Typed errors**. The four error classes (`AuthError`, `HttpError`,
//   `NetworkError`, `ParseError`) carry just enough structure for upstream
//   callers (collectors, the health service, the IPC layer) to map them onto
//   the four failure shapes recorded in `openclash_snapshots` without having
//   to peek at status codes again.
// - **`testNodeDelay` is non-throwing for non-auth failures**. Per-node delay
//   probes are *expected* to fail (slow nodes, dead nodes, throttled probes).
//   We surface the failure in `DelayResult` rather than throwing so the
//   node-scan caller does not record a controller-level outage on every dead
//   node. Auth errors still throw because they indicate the whole client is
//   misconfigured, not just one node.
// - **`getTraffic` returns `null` for soft failures only**. The `/traffic`
//   endpoint is optional in some Clash builds. A 404 or unparseable body is
//   treated as "the controller does not expose traffic" (`null`); 401, 5xx,
//   and network failures still throw because those signal a controller-level
//   problem the caller should record.
// - **No Electron imports at module top level**. The file imports only Node
//   built-ins, zod, and the project's own modules so it can be exercised
//   from a non-Electron test runner. The default `getSecret` reaches
//   into the secrets singleton lazily, only when a request actually fires.
// - **Body capping for `HttpError`**. We capture at most 1 KiB of the
//   response body to avoid ballooning logs if the controller hands back
//   a multi-megabyte error page.

import type { ZodIssue } from 'zod';

import {
  configsResponseSchema,
  proxiesResponseSchema,
} from '../schemas';
import { secrets } from '../security/secrets';
import type {
  ConfigsResponse,
  DelayResult,
  ProxiesResponse,
  TrafficSnapshot,
} from '../types';

// Re-export the pure group-identification helpers so callers that already
// depend on this module don't need to chase a separate import path. The
// implementation lives in `openclash.groups.ts` to keep it free of fetch
// and zod dependencies (see that file's header for rationale).
export {
  EXCLUDED_NODE_NAMES,
  countRealOptions,
  identifyPrimaryGroup,
} from './openclash.groups';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_SECRET_KEY = 'openclash.controllerSecret';
/** Cap captured error bodies so a misbehaving controller cannot bloat logs. */
const ERROR_BODY_BYTE_CAP = 1_024;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the controller responds with HTTP 401. Indicates either a
 * missing/incorrect `openclash.controllerSecret` or a controller that has
 * been reconfigured to require auth. The caller maps this onto the
 * `'auth_error'` value of `openclash_snapshots.status`.
 */
export class AuthError extends Error {
  public override readonly name = 'AuthError';
  public readonly status = 401 as const;

  public constructor(message = 'OpenClash controller returned 401 Unauthorized') {
    super(message);
  }
}

/**
 * Thrown when the controller returns a non-2xx response other than 401.
 * Carries the status code, the reason phrase, and a body excerpt (capped
 * at ~1 KiB) so the caller can log a useful error without stashing
 * megabyte payloads.
 */
export class HttpError extends Error {
  public override readonly name = 'HttpError';
  public readonly status: number;
  public readonly statusText: string;
  public readonly body?: string;

  public constructor(
    status: number,
    statusText: string,
    body?: string,
    message?: string,
  ) {
    super(
      message ??
        `OpenClash controller returned HTTP ${status} ${statusText}`.trim(),
    );
    this.status = status;
    this.statusText = statusText;
    if (body !== undefined) {
      this.body = body;
    }
  }
}

/**
 * Thrown when the underlying `fetch` rejects: DNS failure, connection
 * refused, abort due to timeout, etc. The original error is kept on
 * `cause` so callers can classify it (e.g. "timeout" vs "refused").
 */
export class NetworkError extends Error {
  public override readonly name = 'NetworkError';
  public override readonly cause: unknown;

  public constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** Summary of a single zod issue, kept on `ParseError` for diagnostics. */
export interface ParseIssueSummary {
  path: string;
  message: string;
  code: string;
}

/**
 * Thrown when the response body cannot be parsed as JSON, or when the
 * parsed shape fails the corresponding zod schema. Carries a summarised
 * issues list (zod messages with dotted paths) so the cause can be
 * surfaced in logs without dumping the entire response body.
 */
export class ParseError extends Error {
  public override readonly name = 'ParseError';
  public readonly issues: ParseIssueSummary[];

  public constructor(message: string, issues: ParseIssueSummary[] = []) {
    super(message);
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Live source of the controller URL.
 *
 * - Pass a `string` for stable test fixtures.
 * - Pass `() => string` in production so that user edits in Settings
 *   take effect on the next request without restarting the service.
 *
 * Internally the client always normalises this to a getter (see
 * `resolveUrl`).
 */
export type ControllerUrlSource = string | (() => string);

export interface OpenClashClientDeps {
  /** Either a fixed URL (e.g. `http://192.168.31.100:9090`) or a getter. */
  controllerUrl: ControllerUrlSource;
  /**
   * Optional override for secret retrieval. Defaults to
   * `secrets.get('openclash.controllerSecret')` which is evaluated on every
   * request so live updates from the Settings view take effect immediately.
   * Return `null` (or empty string) to indicate "no secret configured" —
   * the client will then omit the `Authorization` header entirely.
   */
  getSecret?: () => string | null;
  /** Override for `fetch` (used in tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request default timeout in milliseconds. Defaults to 5000 ms. */
  defaultTimeoutMs?: number;
}

export interface OpenClashRequestOptions {
  /** Override the request timeout for this call (ms). */
  timeoutMs?: number;
}

export interface OpenClashClient {
  /** `GET /configs` — parsed and validated against `configsResponseSchema`. */
  getConfigs(opts?: OpenClashRequestOptions): Promise<ConfigsResponse>;
  /** `GET /proxies` — parsed and validated against `proxiesResponseSchema`. */
  getProxies(opts?: OpenClashRequestOptions): Promise<ProxiesResponse>;
  /**
   * `GET /proxies/{node}/delay?url=...&timeout={timeoutMs}`.
   *
   * Returns a `DelayResult` for both 2xx and most non-2xx responses. The
   * sole throwing path is HTTP 401, which surfaces as `AuthError` so the
   * node-scan caller can record a single controller-level auth failure
   * instead of spamming auth errors per node.
   */
  testNodeDelay(
    node: string,
    probeUrl: string,
    timeoutMs: number,
  ): Promise<DelayResult>;
  /**
   * `GET /traffic` — returns `null` when the controller does not expose
   * traffic data (404) or when the response cannot be parsed. Throws on
   * 401, 5xx, and network failures.
   */
  getTraffic(opts?: OpenClashRequestOptions): Promise<TrafficSnapshot | null>;
  /**
   * Raw `PUT /proxies/{group}` body `{ name: node }`. Resolves with
   * `void` on a 2xx response. Switch verification (delay + GET retry)
   * is implemented one layer up in task 3.5.
   */
  putGroupSelection(
    group: string,
    node: string,
    opts?: OpenClashRequestOptions,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Normalise the URL source into a getter. */
function resolveUrl(source: ControllerUrlSource): () => string {
  return typeof source === 'function' ? source : () => source;
}

/** Strip a trailing slash from the controller root before composing paths. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Build the `Authorization: Bearer …` header lazily. We never log the
 * value; the only place it appears is in the outgoing request headers.
 */
function buildAuthHeader(getSecret: () => string | null): string | null {
  const secret = getSecret();
  if (typeof secret !== 'string' || secret.length === 0) {
    return null;
  }
  return `Bearer ${secret}`;
}

/**
 * Classify a fetch rejection cause for the `error` field of `DelayResult`.
 * Node's `fetch` raises a `TypeError` whose `cause` carries the underlying
 * Undici error; aborts surface as a `DOMException` with name `AbortError`
 * or `TimeoutError` (the latter from `AbortSignal.timeout`). We only need
 * a short tag — the full cause stays on `NetworkError.cause` for callers
 * that need it.
 */
function classifyCause(cause: unknown): string {
  if (cause === undefined || cause === null) {
    return 'network_error';
  }
  if (typeof cause === 'object' && 'name' in cause) {
    const name = (cause as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) {
      if (name === 'TimeoutError' || name === 'AbortError') {
        return 'timeout';
      }
      return name;
    }
  }
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return 'network_error';
}

/** Truncate a string by *byte* length (UTF-8) to keep logs bounded. */
function truncateBody(body: string, maxBytes: number): string {
  // Quick path: if every char is ASCII the byte length equals the char
  // length, and string slicing is byte-safe.
  if (body.length <= maxBytes) {
    return body;
  }
  const buf = Buffer.from(body, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return body;
  }
  return `${buf.subarray(0, maxBytes).toString('utf8')}…`;
}

/**
 * Read at most `ERROR_BODY_BYTE_CAP` bytes of the response body. We never
 * throw from this helper — failure to read the body must not mask the
 * original HTTP error.
 */
async function readCappedBody(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.length === 0) {
      return undefined;
    }
    return truncateBody(text, ERROR_BODY_BYTE_CAP);
  } catch {
    return undefined;
  }
}

function summariseIssues(issues: readonly ZodIssue[]): ParseIssueSummary[] {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

interface RequestArgs {
  method: 'GET' | 'PUT';
  url: string;
  timeoutMs: number;
  body?: string;
  /** Set on PUT requests so we can attach a sane `Content-Type`. */
  contentType?: string;
}

interface RequestContext {
  getSecret: () => string | null;
  fetchImpl: typeof fetch;
}

/**
 * Execute a single HTTP request. Wraps fetch failures into `NetworkError`
 * and forwards 2xx responses verbatim; non-2xx responses are returned to
 * the caller (they have to make the auth-vs-non-auth distinction).
 */
async function performRequest(
  args: RequestArgs,
  ctx: RequestContext,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const auth = buildAuthHeader(ctx.getSecret);
  if (auth !== null) {
    headers.Authorization = auth;
  }
  if (args.contentType !== undefined && args.body !== undefined) {
    headers['Content-Type'] = args.contentType;
  }

  const init: RequestInit = {
    method: args.method,
    headers,
    signal: AbortSignal.timeout(args.timeoutMs),
  };
  if (args.body !== undefined) {
    init.body = args.body;
  }

  try {
    return await ctx.fetchImpl(args.url, init);
  } catch (cause) {
    const tag = classifyCause(cause);
    throw new NetworkError(
      `OpenClash request failed (${args.method} ${args.url}): ${tag}`,
      cause,
    );
  }
}

/**
 * Throw an `AuthError` for 401 and `HttpError` for other non-2xx codes.
 * On 2xx, returns the response unchanged for the caller to consume.
 */
async function rejectIfNotOk(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  if (response.status === 401) {
    throw new AuthError();
  }
  const body = await readCappedBody(response);
  throw new HttpError(response.status, response.statusText, body);
}

/**
 * Read the response body as JSON, wrapping any failure in `ParseError`.
 */
async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ParseError('failed to read response body', [
      {
        path: '',
        message: cause instanceof Error ? cause.message : 'unknown error',
        code: 'read_error',
      },
    ]);
  }
  if (text.length === 0) {
    throw new ParseError('response body was empty', []);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ParseError('response body was not valid JSON', [
      {
        path: '',
        message: cause instanceof Error ? cause.message : 'unknown error',
        code: 'invalid_json',
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an `OpenClashClient`. The client is a plain object — no I/O is
 * performed until one of its methods is called.
 *
 * The factory is the only public export beyond the typed errors; tests
 * inject `fetchImpl` and `getSecret` to drive the client without touching
 * Electron `safeStorage` or the network.
 */
export function createOpenClashClient(
  deps: OpenClashClientDeps,
): OpenClashClient {
  const getUrl = resolveUrl(deps.controllerUrl);
  const getSecret =
    deps.getSecret ??
    ((): string | null => {
      // The secrets singleton is initialised during `app.ts` boot. If a
      // caller wires the client too early (before `initSecrets`) the
      // singleton accessor throws; we treat that as "no secret available"
      // rather than propagating the error, because every request would
      // then fail in surprising ways during boot.
      try {
        return secrets.get(DEFAULT_SECRET_KEY);
      } catch {
        return null;
      }
    });
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctx: RequestContext = { getSecret, fetchImpl };

  function timeoutOf(opts?: OpenClashRequestOptions): number {
    if (opts?.timeoutMs !== undefined && opts.timeoutMs > 0) {
      return opts.timeoutMs;
    }
    return defaultTimeoutMs;
  }

  function buildPath(suffix: string): string {
    return `${trimTrailingSlash(getUrl())}${suffix}`;
  }

  return {
    async getConfigs(opts?: OpenClashRequestOptions): Promise<ConfigsResponse> {
      const response = await performRequest(
        {
          method: 'GET',
          url: buildPath('/configs'),
          timeoutMs: timeoutOf(opts),
        },
        ctx,
      );
      await rejectIfNotOk(response);
      const body = await readJson(response);
      const parsed = configsResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new ParseError(
          '/configs response shape did not match schema',
          summariseIssues(parsed.error.issues),
        );
      }
      // The interface allows arbitrary extra keys via `[key: string]: unknown`,
      // which zod's inferred type does not represent literally. Cast through
      // `unknown` keeps the boundary explicit.
      return parsed.data as unknown as ConfigsResponse;
    },

    async getProxies(opts?: OpenClashRequestOptions): Promise<ProxiesResponse> {
      const response = await performRequest(
        {
          method: 'GET',
          url: buildPath('/proxies'),
          timeoutMs: timeoutOf(opts),
        },
        ctx,
      );
      await rejectIfNotOk(response);
      const body = await readJson(response);
      const parsed = proxiesResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new ParseError(
          '/proxies response shape did not match schema',
          summariseIssues(parsed.error.issues),
        );
      }
      return parsed.data as unknown as ProxiesResponse;
    },

    async testNodeDelay(
      node: string,
      probeUrl: string,
      timeoutMs: number,
    ): Promise<DelayResult> {
      const t = timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
      const path =
        `/proxies/${encodeURIComponent(node)}/delay` +
        `?url=${encodeURIComponent(probeUrl)}` +
        `&timeout=${t}`;
      const url = buildPath(path);

      let response: Response;
      try {
        response = await performRequest(
          { method: 'GET', url, timeoutMs: t },
          ctx,
        );
      } catch (err) {
        if (err instanceof AuthError) {
          // Auth errors propagate so the caller can stop the scan.
          throw err;
        }
        if (err instanceof NetworkError) {
          return {
            ok: false,
            delay: null,
            error: classifyCause(err.cause),
          };
        }
        throw err;
      }

      if (response.status === 401) {
        // Drain the body so the connection is freed.
        await readCappedBody(response);
        throw new AuthError();
      }

      if (!response.ok) {
        // Non-2xx: surface as a soft failure. Drain the body to free the
        // socket but otherwise ignore — the controller's error JSON
        // contains no actionable information beyond the status code.
        await readCappedBody(response);
        return {
          ok: false,
          delay: null,
          error: response.statusText.length > 0
            ? response.statusText
            : `http_${response.status}`,
        };
      }

      let parsed: unknown;
      try {
        parsed = await readJson(response);
      } catch {
        return { ok: false, delay: null, error: 'invalid_response' };
      }

      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'delay' in parsed &&
        typeof (parsed as { delay: unknown }).delay === 'number'
      ) {
        const delay = (parsed as { delay: number }).delay;
        if (Number.isFinite(delay) && delay >= 0) {
          return { ok: true, delay };
        }
      }
      return { ok: false, delay: null, error: 'invalid_response' };
    },

    async getTraffic(
      opts?: OpenClashRequestOptions,
    ): Promise<TrafficSnapshot | null> {
      const url = buildPath('/traffic');
      const response = await performRequest(
        {
          method: 'GET',
          url,
          timeoutMs: timeoutOf(opts),
        },
        ctx,
      );

      if (response.status === 401) {
        await readCappedBody(response);
        throw new AuthError();
      }
      if (response.status === 404) {
        // Some Clash builds disable `/traffic`. Treat as "feature not
        // available" rather than an error.
        await readCappedBody(response);
        return null;
      }
      if (!response.ok) {
        const body = await readCappedBody(response);
        throw new HttpError(response.status, response.statusText, body);
      }

      // The `/traffic` endpoint is a streaming JSON-lines response in
      // upstream Clash; some forks return a single JSON snapshot. We try
      // to read the body as text (already aborted by the timeout above)
      // and parse the first complete JSON object we see.
      let text: string;
      try {
        text = await response.text();
      } catch {
        return null;
      }
      const candidate = extractFirstJsonObject(text);
      if (candidate === null) {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate) as unknown;
      } catch {
        return null;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { up?: unknown }).up === 'number' &&
        typeof (parsed as { down?: unknown }).down === 'number'
      ) {
        const { up, down } = parsed as { up: number; down: number };
        if (Number.isFinite(up) && Number.isFinite(down)) {
          return { up, down };
        }
      }
      return null;
    },

    async putGroupSelection(
      group: string,
      node: string,
      opts?: OpenClashRequestOptions,
    ): Promise<void> {
      const url = buildPath(`/proxies/${encodeURIComponent(group)}`);
      const response = await performRequest(
        {
          method: 'PUT',
          url,
          timeoutMs: timeoutOf(opts),
          body: JSON.stringify({ name: node }),
          contentType: 'application/json',
        },
        ctx,
      );
      await rejectIfNotOk(response);
      // Drain the (typically empty) body so the underlying socket is
      // returned to the pool promptly.
      await readCappedBody(response);
    },
  };
}

/**
 * Extract the first balanced JSON object from a text buffer. Used by
 * `getTraffic` because Clash streams JSON lines and we just want the
 * first snapshot. Returns `null` if no balanced object is found.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) {
      return null;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
