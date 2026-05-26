// Feature: network-quick-actions, Property 12: CSP rebuild includes both origins, deduplicated.
//
// Validates Requirements 13.4, 13.5.
//
// Property 12 (from network-quick-actions/design.md):
//   For arbitrary `controllerUrl` and `managementInterface.url`, the CSP
//   `connect-src` directive built from `computeRendererAllowedOrigins(...)`
//   and `buildCspHeaderValue(...)` must:
//     1. Always begin with `'self'`.
//     2. Contain the controller origin.
//     3. Contain the management origin when the management URL is non-empty
//        and parseable.
//     4. Contain each origin at most once (Requirement 13.5 dedup).
//     5. Not leak any blank-origin / `'undefined'` artifact when the
//        management URL is the empty string (the v1 default).
//     6. Treat URLs differing only by port as distinct origins (RFC 6454)
//        and keep both in connect-src.
//     7. Fold string-equal `controllerUrl === managementUrl` to a single
//        origin entry.
//
// We test the PURE helpers `computeRendererAllowedOrigins` and
// `buildCspHeaderValue` only. `applyCspHeaders` calls into Electron's
// `webRequest` API and is not unit-testable without the Electron runtime.
//
// `electron` is mocked so `app.isPackaged === true`. That makes
// `resolveRendererTarget` return the `file://` branch, which means
// `computeRendererAllowedOrigins` does NOT add dev-server origins
// (`http://localhost:5173`, `ws://localhost:*`) to the connect list —
// the resulting set is exactly `{ controllerOrigin, [managementOrigin] }`,
// which is what Requirement 13.5 dedup is about.

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('electron', () => ({
  // Packaged build → no dev-server origin is injected into the connect
  // allowlist, keeping the property under test deterministic.
  app: { isPackaged: true },
  // The factories pull in `BrowserWindow`, `screen`, and `session`, but
  // none of them are reached by the pure helpers we exercise here. Stub
  // them out as inert objects to keep the module import side-effect free.
  BrowserWindow: class {},
  screen: { getAllDisplays: () => [] },
  session: { defaultSession: {} },
}));

import {
  buildCspHeaderValue,
  computeRendererAllowedOrigins,
} from './windows';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract just the `connect-src ...` directive substring from the CSP
 * header value. Returns the directive minus the trailing `;` (or the
 * end of string), with leading/trailing whitespace trimmed.
 */
function extractConnectSrc(csp: string): string {
  const idx = csp.indexOf('connect-src');
  expect(idx).toBeGreaterThanOrEqual(0);
  const tail = csp.slice(idx);
  const semi = tail.indexOf(';');
  return (semi === -1 ? tail : tail.slice(0, semi)).trim();
}

/**
 * Count whitespace-delimited tokens in `directive` that match `origin`
 * exactly. Token-based comparison is required because CSP origins can
 * be prefixes of one another (e.g. `http://1.2.3.4` is a prefix of
 * `http://1.2.3.4:8080` since `URL.origin` strips default ports), and
 * a naive substring count would double-count the shorter origin.
 */
function countOriginTokens(directive: string, origin: string): number {
  if (origin.length === 0) return 0;
  const tokens = directive.split(/\s+/);
  let count = 0;
  for (const t of tokens) {
    if (t === origin) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const protocolArb = fc.constantFrom('http', 'https');
const hostArb = fc.constantFrom(
  '192.168.1.1',
  '10.0.0.1',
  '127.0.0.1',
  '172.16.0.5',
  'controller.example.com',
  'luci.local',
);
const portArb = fc.integer({ min: 1, max: 65535 });

/** http/https URL with random host and explicit port. Always parseable. */
const urlArb: fc.Arbitrary<string> = fc
  .tuple(protocolArb, hostArb, portArb)
  .map(([proto, host, port]) => `${proto}://${host}:${port}`);

/**
 * Management-URL arbitrary that mixes:
 *   - real http/https URLs (most common),
 *   - the empty string (v1 default until the user configures it),
 *   - whitespace-only strings (treated as empty by `tryOriginOrNull`),
 *   - `undefined` (caller may omit the field entirely).
 */
const managementUrlArb: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 6, arbitrary: urlArb },
  { weight: 2, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constantFrom('   ', '\t', ' \n ') },
  { weight: 1, arbitrary: fc.constant(undefined) },
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('windows CSP rebuild — Property 12 (network-quick-actions)', () => {
  it('connect-src contains \'self\', controller origin, and management origin (when set), each at most once', () => {
    fc.assert(
      fc.property(urlArb, managementUrlArb, (controllerUrl, managementUrl) => {
        const { connect } = computeRendererAllowedOrigins({
          controllerUrl,
          managementUrl,
        });
        const csp = buildCspHeaderValue(connect);
        const directive = extractConnectSrc(csp);

        // (1) Always starts with `connect-src 'self'`.
        expect(directive.startsWith("connect-src 'self'")).toBe(true);

        // (2) Controller origin is present.
        const ctlOrigin = new URL(controllerUrl).origin;
        expect(directive).toContain(ctlOrigin);

        // (3) Management origin is present iff the URL is non-empty and
        //     parseable (i.e. `tryOriginOrNull` returned a value).
        const trimmedMgmt = (managementUrl ?? '').trim();
        let mgmtOrigin: string | null = null;
        if (trimmedMgmt.length > 0) {
          try {
            mgmtOrigin = new URL(trimmedMgmt).origin;
          } catch {
            mgmtOrigin = null;
          }
        }
        if (mgmtOrigin !== null) {
          expect(directive).toContain(mgmtOrigin);
        }

        // (4) Each origin appears at most once across the connect-src
        //     directive (Requirement 13.5 dedup).
        expect(countOriginTokens(directive, ctlOrigin)).toBe(1);
        if (mgmtOrigin !== null && mgmtOrigin !== ctlOrigin) {
          expect(countOriginTokens(directive, mgmtOrigin)).toBe(1);
        }

        // (5) The connect array itself contains no duplicates — Set
        //     length matches Array length.
        expect(new Set(connect).size).toBe(connect.length);
      }),
      { numRuns: 100 },
    );
  });

  it('same-origin controller and management URLs fold to a single origin entry', () => {
    fc.assert(
      fc.property(urlArb, (sameUrl) => {
        const { connect } = computeRendererAllowedOrigins({
          controllerUrl: sameUrl,
          managementUrl: sameUrl,
        });
        const csp = buildCspHeaderValue(connect);
        const directive = extractConnectSrc(csp);

        const origin = new URL(sameUrl).origin;
        // The shared origin appears exactly once in connect-src and exactly
        // once in the connect array — no duplication when the strings are
        // string-equal (Requirement 13.5).
        expect(countOriginTokens(directive, origin)).toBe(1);
        expect(connect.filter((o) => o === origin).length).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it('empty / blank / undefined management URL produces no blank-origin artifact', () => {
    fc.assert(
      fc.property(
        urlArb,
        fc.constantFrom('', '   ', '\t', ' \n ', undefined),
        (controllerUrl, blankMgmt) => {
          const { connect } = computeRendererAllowedOrigins({
            controllerUrl,
            managementUrl: blankMgmt,
          });
          const csp = buildCspHeaderValue(connect);
          const directive = extractConnectSrc(csp);

          const ctlOrigin = new URL(controllerUrl).origin;

          // The connect array includes the controller origin and nothing
          // resembling a blank/`undefined` origin.
          for (const entry of connect) {
            expect(entry.length).toBeGreaterThan(0);
            expect(entry).not.toBe('undefined');
            expect(entry).not.toBe('null');
          }
          expect(connect).toContain(ctlOrigin);

          // The directive itself must not contain stand-alone `undefined`,
          // `null`, or an empty-quoted token from the management slot.
          // (`'self'` is fine — it is the renderer's own origin marker.)
          // We split on whitespace so substring matches inside legitimate
          // hostnames don't trip the assertion.
          const tokens = directive.split(/\s+/);
          expect(tokens).not.toContain('undefined');
          expect(tokens).not.toContain('null');
          expect(tokens).not.toContain('""');
          // The connect list itself must not contain duplicates.
          expect(new Set(connect).size).toBe(connect.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('different ports on the same host are distinct origins and both appear', () => {
    fc.assert(
      fc.property(
        protocolArb,
        hostArb,
        portArb,
        portArb,
        (proto, host, portA, portB) => {
          // Constrain the property to genuinely-different ports — equal
          // ports collapse to the same origin and are exercised by the
          // `same-origin` test above.
          fc.pre(portA !== portB);

          const controllerUrl = `${proto}://${host}:${portA}`;
          const managementUrl = `${proto}://${host}:${portB}`;
          const { connect } = computeRendererAllowedOrigins({
            controllerUrl,
            managementUrl,
          });
          const csp = buildCspHeaderValue(connect);
          const directive = extractConnectSrc(csp);

          const ctlOrigin = new URL(controllerUrl).origin;
          const mgmtOrigin = new URL(managementUrl).origin;

          // Both origins are present, each exactly once.
          expect(countOriginTokens(directive, ctlOrigin)).toBe(1);
          expect(countOriginTokens(directive, mgmtOrigin)).toBe(1);
          expect(connect).toContain(ctlOrigin);
          expect(connect).toContain(mgmtOrigin);
          expect(new Set(connect).size).toBe(connect.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
