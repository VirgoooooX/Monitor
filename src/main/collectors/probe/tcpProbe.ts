// TCP connect probe utility.
//
// References:
//   - design.md §TCP Probe
//   - design.md §`tcpProbe` (formal pre/post conditions)
//   - PLAN.md §探测层 §`router_reachable`, §`openclash_tcp_reachable`
//
// Design choices:
//
// - **TCP-only liveness signal.** We do not need (and cannot reliably
//   send, on Windows without admin) ICMP. A successful TCP handshake
//   to the configured host:port is the cheapest evidence the box is
//   alive on the network.
// - **First-of-three race.** `connect`, `timeout`, and `error` are
//   mutually exclusive outcomes. Whichever fires first resolves the
//   promise. The other two listeners are detached implicitly when we
//   `socket.destroy()` in the `finally` branch.
// - **Always destroy.** Even if `net.createConnection` synchronously
//   throws (DNS module misconfigured, exotic env), we leave no FD
//   dangling — the validation step runs first, and the socket is the
//   very last thing we hold a reference to.
// - **No `errno` leakage.** The `error` field is a short
//   classification tag the dashboard can render in zh-CN tooltips;
//   we never surface the raw error message because it can contain
//   absolute paths or environment specifics.
// - **`exactOptionalPropertyTypes` discipline.** The success branch
//   never carries an `error` key (not even `undefined`), matching
//   `ProbeResult` exactly.

import * as net from 'node:net';

import type { ProbeResult } from '../../types';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MIN_PORT = 1;
const MAX_PORT = 65_535;

function validateHost(host: string): void {
  if (typeof host !== 'string' || host.length === 0) {
    throw new TypeError('tcpProbe: host must be a non-empty string');
  }
}

function validatePort(port: number): void {
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < MIN_PORT ||
    port > MAX_PORT
  ) {
    throw new TypeError(
      `tcpProbe: port must be an integer in [${MIN_PORT}, ${MAX_PORT}]`,
    );
  }
}

function validateTimeout(timeoutMs: number): void {
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new TypeError('tcpProbe: timeoutMs must be a positive finite number');
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a socket error into a short tag suitable for the
 * `error` field. Mirrors `httpProbe`'s `classifyFetchError` so the
 * dashboard's "last error" string is consistent across probe types.
 */
export function classifyTcpError(err: unknown): string {
  if (err === undefined || err === null) {
    return 'network_error';
  }
  if (typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0 && name !== 'Error') {
      return name;
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
 * Probe a single TCP endpoint and report whether a handshake
 * completed within the deadline.
 *
 * Pre-conditions (enforced; failures throw `TypeError`):
 *   - `host` is a non-empty string.
 *   - `port` is an integer in [1, 65535].
 *   - `timeoutMs` is a positive finite number.
 *
 * Post-conditions:
 *   - On `connect`: returns `{ ok: true, latencyMs }` where
 *     `latencyMs` is the wall-clock interval from `createConnection`
 *     to the `connect` event.
 *   - On `timeout` / `error` / synchronous throw from
 *     `createConnection`: returns `{ ok: false, latencyMs: null,
 *     error: <tag> }`.
 *   - The underlying socket is always destroyed before the promise
 *     settles. No FD leak under any path.
 *   - The function only throws `TypeError` from input validation;
 *     network failures are reported in the result, never thrown.
 */
export function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  validateHost(host);
  validatePort(port);
  validateTimeout(timeoutMs);

  return new Promise<ProbeResult>((resolve) => {
    const start = performance.now();
    let socket: net.Socket | null = null;
    let settled = false;

    const finalize = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      if (socket !== null) {
        try {
          socket.destroy();
        } catch {
          // socket.destroy is documented as never throwing, but be
          // defensive: a custom socket impl in tests might.
        }
      }
      resolve(result);
    };

    try {
      socket = net.createConnection({ host, port });
    } catch (err) {
      // Synchronous throw — there is no socket to destroy.
      resolve({
        ok: false,
        latencyMs: null,
        error: classifyTcpError(err),
      });
      return;
    }

    // Post-construction setup is wrapped so that an exotic socket impl
    // throwing from `setTimeout` / `once` (we have seen this in test
    // doubles) still goes through `finalize` and destroys the FD.
    try {
      socket.setTimeout(timeoutMs);

      socket.once('connect', () => {
        const latencyMs = performance.now() - start;
        finalize({ ok: true, latencyMs });
      });

      socket.once('timeout', () => {
        finalize({ ok: false, latencyMs: null, error: 'timeout' });
      });

      socket.once('error', (err) => {
        finalize({
          ok: false,
          latencyMs: null,
          error: classifyTcpError(err),
        });
      });
    } catch (err) {
      finalize({
        ok: false,
        latencyMs: null,
        error: classifyTcpError(err),
      });
    }
  });
}
