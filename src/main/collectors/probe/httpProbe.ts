// HTTP probe utility for `probeUrls`.
//
// References:
//   - design.md §Health Sampling Tick (per-tick HTTP probe against each
//     configured `probeUrls` entry)
//   - design.md §Validation rules (`probeUrls` must be `https?://...`)
//   - PLAN.md §探测层 §`current_node_external_ok` ("the current node has
//     a real successful HTTP probe to at least one entry in `probeUrls`")
//
// Design choices encoded here:
//
// - **Probe semantics, not browser semantics.** Anything in `2xx`/`3xx` is
//   treated as success because the only thing the caller wants to know is
//   "did the proxy chain forward us to *something* that answered?" — a 301
//   to a CDN or a 308 from a country-redirect page is just as good as a 200.
//   4xx/5xx are surfaced as `ok=false` but with a populated `status` so the
//   caller can distinguish "we reached a server that hated us" from "we
//   never reached anything".
// - **Latency from request start to response start.** We stop the clock as
//   soon as `fetch` resolves with a `Response` (i.e. headers are in). Body
//   download time is irrelevant to "is the node alive" — and worse, on a
//   slow node it would inflate every probe by the body size.
// - **No body buffering.** We try to cancel the body stream right away so
//   the underlying socket is freed without us waiting for a potentially
//   large payload. Cancellation failures are swallowed because they are
//   never actionable (the probe has already produced its result).
// - **`fetchImpl` injection.** Tests can pass a stubbed fetch without
//   monkey-patching `globalThis`. In production the call site uses
//   `globalThis.fetch` (Node 22 provides it via Undici).
// - **`exactOptionalPropertyTypes` discipline.** The success branch never
//   carries an `error` key (not even `undefined`), matching the
//   `HttpProbeResult` shape exactly.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of a single HTTP probe.
 *
 * - `ok` is `true` iff the response status was in the 2xx or 3xx range.
 * - `status` carries the HTTP status code on every response, success or
 *   failure; it is `null` only on network-level failure (timeout, DNS,
 *   connection refused, etc.) where no status was ever received.
 * - `latencyMs` is the wall-clock interval from request start to response
 *   start (i.e. the moment `fetch` resolved with a `Response`). It is
 *   `null` on network-level failure.
 * - `error` is set only when `ok === false`. Successful results MUST NOT
 *   include the key (compatible with `exactOptionalPropertyTypes`).
 */
export interface HttpProbeResult {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate `url`. We accept only `http:` and `https:` because the
 * controller never proxies anything else, and a typo'd `ws://` URL
 * would otherwise sit in settings and silently fail every tick.
 *
 * Throws `TypeError` on any failure so that misconfigured probes blow
 * up at boot rather than producing a stream of `ok=false` rows.
 */
function validateUrl(url: string): void {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('httpProbe: url must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`httpProbe: url is not parseable: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(
      `httpProbe: url must be http:// or https:// (got ${parsed.protocol})`,
    );
  }
}

function validateTimeout(timeoutMs: number): void {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new TypeError('httpProbe: timeoutMs must be a positive finite number');
  }
}

/**
 * Best-effort cancellation of the response body so the underlying socket
 * is released back to the pool. We never await any work that depends on
 * the body, and any cancellation error is irrelevant — the probe result
 * is already fixed by the time we get here.
 */
function discardBody(response: Response): void {
  const body = response.body;
  if (body === null || body === undefined) {
    return;
  }
  // `cancel` may be missing on exotic stream impls used by mocks.
  const cancel = (body as { cancel?: (reason?: unknown) => Promise<void> })
    .cancel;
  if (typeof cancel !== 'function') {
    return;
  }
  try {
    void cancel.call(body).catch(() => {
      // Cancellation failures are not actionable.
    });
  } catch {
    // Synchronous throw from a malformed stream — also not actionable.
  }
}

/**
 * Classify a fetch rejection into a short error tag suitable for the
 * `error` field. Mirrors `tcpProbe`'s classifier so the dashboard's
 * "last error" string is consistent across probe types.
 *
 * Node's `fetch` raises one of:
 *   - a `DOMException` whose `name` is `'AbortError'` or `'TimeoutError'`
 *     when `AbortSignal.timeout(...)` fires;
 *   - a `TypeError` with `cause` set to an Undici error (which usually
 *     has a `code` like `'ECONNREFUSED'`, `'ENOTFOUND'`, `'UND_ERR_*'`);
 *   - a plain `Error` for unexpected internal failures.
 */
export function classifyFetchError(err: unknown): string {
  if (err === undefined || err === null) {
    return 'network_error';
  }

  // Direct DOMException (timeout/abort) — Node's AbortSignal.timeout emits
  // a DOMException named 'TimeoutError'; user-triggered aborts emit
  // 'AbortError'. Both map to our 'timeout' tag because the only abort
  // path we use is the timeout signal.
  if (typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return 'timeout';
    }
  }

  // `cause` chain — Node fetch wraps Undici errors here.
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null && typeof cause === 'object') {
    const causeName = (cause as { name?: unknown }).name;
    if (causeName === 'TimeoutError' || causeName === 'AbortError') {
      return 'timeout';
    }
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    if (typeof causeName === 'string' && causeName.length > 0) {
      return causeName;
    }
    if (cause instanceof Error && cause.message.length > 0) {
      return cause.message;
    }
  }

  if (err instanceof Error && err.message.length > 0) {
    return err.message;
  }
  return 'network_error';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Probe a single HTTP(S) URL and report whether it answered within the
 * deadline.
 *
 * Pre-conditions (enforced; failures throw `TypeError`):
 *   - `url` is a non-empty string parseable by `new URL` whose protocol
 *     is `http:` or `https:`.
 *   - `timeoutMs` is a positive finite number.
 *
 * Post-conditions:
 *   - On HTTP response: `status` is set to `response.status`,
 *     `latencyMs` is the time from request start to response start,
 *     `ok` is true iff `status` ∈ [200, 400). The body is discarded.
 *   - On network-level failure (timeout, DNS, refused, reset, …):
 *     `status` and `latencyMs` are both `null`, `ok` is `false`, and
 *     `error` carries a short classification tag.
 *   - The function never throws on network failure; the only exceptions
 *     it raises are `TypeError`s from input validation.
 *
 * @param url        URL to probe. Must be http(s).
 * @param timeoutMs  Per-request deadline in milliseconds.
 * @param fetchImpl  Optional fetch override (for tests). Defaults to
 *                   `globalThis.fetch`.
 */
export async function httpProbe(
  url: string,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<HttpProbeResult> {
  validateUrl(url);
  validateTimeout(timeoutMs);

  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new TypeError('httpProbe: no fetch implementation available');
  }

  const start = performance.now();

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      status: null,
      latencyMs: null,
      error: classifyFetchError(err),
    };
  }

  const latencyMs = performance.now() - start;
  // Free the socket; we never inspect the body.
  discardBody(response);

  const status = response.status;
  const ok = status >= 200 && status < 400;
  if (ok) {
    // exactOptionalPropertyTypes: do not emit an `error` key at all on
    // the success branch.
    return { ok, status, latencyMs };
  }

  return {
    ok,
    status,
    latencyMs,
    error: response.statusText.length > 0
      ? response.statusText
      : `http_${status}`,
  };
}
