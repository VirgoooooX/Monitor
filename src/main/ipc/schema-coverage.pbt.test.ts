// Feature: network-quick-actions, Property 17: New IPC channels have schemas.
//
// Validates Requirements 11.3.
//
// Property 17 (from network-quick-actions/design.md §Correctness Properties):
//   For every NEW IPC channel introduced by the network-quick-actions
//   spec — `getNetworkQuickActions`, `switchOpenClashConfig`, and
//   `clearManagementCredentials` — the following three invariants must
//   hold:
//
//     1. The channel constant exists in `DESKTOP_INVOKE_CHANNELS` with
//        the expected `desktop:<methodName>` string value.
//
//     2. An entry exists in `desktopApiSchemas` keyed by the same
//        method name, exposing both `input` and `output` zod schemas
//        (so the IPC handler registry can validate payloads on both
//        directions of the wire).
//
//     3. For arbitrary STRICTLY-INVALID payloads, the registered
//        `input` schema's `safeParse` returns `{ success: false }`.
//        The IPC handler registry maps that failure to
//        `{ ok: false, error: { code: 'validation', ... } }` BEFORE
//        any underlying service is invoked
//        (`src/main/ipc/index.ts` `VALIDATION_FAILURE`); we exercise
//        the schema directly here because the task description marks
//        the registry-level handler test as optional and prefers the
//        schema-level assertion alone.
//
// Why schema-level only (not the full registry)
// ---------------------------------------------
// Wiring up `IpcRegistryDeps` for a property test would require
// fakes for the dashboard, OpenClash client, switch-node service,
// management client, switch lock, audit writer, and repositories —
// none of which are exercised by Property 17 itself. The IPC handler
// registry's `VALIDATION_FAILURE` short-circuit at the head of every
// handler (`src/main/ipc/index.ts`) is mechanically equivalent to a
// failing `desktopApiSchemas[channel].input.safeParse(payload)`, so
// asserting the schema alone is sufficient and avoids redundant
// scaffolding.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { DESKTOP_INVOKE_CHANNELS } from './channels';
import { desktopApiSchemas } from '../schemas';

// ---------------------------------------------------------------------------
// Existence checks (concrete, not property-based)
// ---------------------------------------------------------------------------
//
// Per the task description: "Existence checks (concrete tests, not
// property-based)". These three `it` blocks lock down the channel
// constants and the `desktopApiSchemas` map shape; the property-based
// schema-rejection check follows below.

describe('Property 17 existence checks — new IPC channel constants', () => {
  it('declares the `getNetworkQuickActions` channel with the desktop: prefix', () => {
    expect(DESKTOP_INVOKE_CHANNELS.getNetworkQuickActions).toBe(
      'desktop:getNetworkQuickActions',
    );
  });

  it('declares the `switchOpenClashConfig` channel with the desktop: prefix', () => {
    expect(DESKTOP_INVOKE_CHANNELS.switchOpenClashConfig).toBe(
      'desktop:switchOpenClashConfig',
    );
  });

  it('declares the `clearManagementCredentials` channel with the desktop: prefix', () => {
    expect(DESKTOP_INVOKE_CHANNELS.clearManagementCredentials).toBe(
      'desktop:clearManagementCredentials',
    );
  });
});

describe('Property 17 existence checks — desktopApiSchemas registration', () => {
  // We type-narrow via key access on the exported `desktopApiSchemas`
  // map directly. Each new method must register both an `input` and
  // an `output` schema; missing either side would cause the IPC
  // handler registry in `src/main/ipc/index.ts` to fail at construction.
  it.each([
    ['getNetworkQuickActions'] as const,
    ['switchOpenClashConfig'] as const,
    ['clearManagementCredentials'] as const,
  ])('registers an input + output schema for `%s`', (method) => {
    const entry = desktopApiSchemas[method];
    expect(entry).toBeDefined();
    expect(entry.input).toBeDefined();
    expect(entry.output).toBeDefined();
    // safeParse exists on every zod schema; the duck-typed assertion
    // confirms `entry.input` / `entry.output` are zod schemas without
    // depending on a particular zod-internal type symbol.
    expect(typeof entry.input.safeParse).toBe('function');
    expect(typeof entry.output.safeParse).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Property-based: malformed payloads yield validation failure
// ---------------------------------------------------------------------------

/**
 * Arbitrary that generates strictly-invalid payloads for the two
 * void-input channels (`getNetworkQuickActions` and
 * `clearManagementCredentials`).
 *
 * Both channels register `emptyInputSchema = z.union([z.undefined(),
 * z.void()])` as their input schema, so the only valid payload is
 * `undefined`. We exclude `undefined` by construction (every branch
 * below produces a concrete non-undefined value), which is stronger
 * than `fc.anything().filter(v => v !== undefined)` because filtering
 * can shrink towards the rejected boundary and bias the example
 * distribution.
 */
const malformedVoidPayload = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double({ noNaN: true }),
  fc.string(),
  fc.array(fc.anything()),
  fc.object(),
  fc.record({ extra: fc.string() }),
);

/**
 * Arbitrary that generates strictly-invalid payloads for
 * `switchOpenClashConfig`.
 *
 * The registered input schema is
 * `z.object({ targetPath: trimmedNonEmpty }).strict()`. Strict mode
 * rejects any record that adds a key beyond `targetPath`; the
 * trimmed-non-empty refinement rejects empty / whitespace-only
 * strings; non-object scalars are rejected outright. None of the
 * branches below can ever produce a record whose only key is
 * `targetPath` carrying a non-empty trimmed string, so every drawn
 * example is GUARANTEED to be invalid.
 */
const malformedSwitchOpenClashConfigPayload = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.integer(),
  fc.array(fc.string()),
  // `withDeletedKeys: true` lets fast-check sometimes emit the empty
  // object `{}` (missing required `targetPath`) and sometimes
  // `{ wrongField: '...' }` (strict-mode unknown-key violation).
  // Either way, the only key the record can carry is `wrongField`,
  // never `targetPath`, so the schema cannot accept it.
  fc.record(
    { wrongField: fc.string() },
    { withDeletedKeys: true },
  ),
);

describe('Property 17 — desktopApiSchemas rejects malformed payloads', () => {
  it('rejects every non-undefined payload for `getNetworkQuickActions`', () => {
    fc.assert(
      fc.property(malformedVoidPayload, (payload) => {
        const result = desktopApiSchemas.getNetworkQuickActions.input.safeParse(
          payload,
        );
        return result.success === false;
      }),
      { numRuns: 100 },
    );
  });

  it('rejects every non-undefined payload for `clearManagementCredentials`', () => {
    fc.assert(
      fc.property(malformedVoidPayload, (payload) => {
        const result =
          desktopApiSchemas.clearManagementCredentials.input.safeParse(payload);
        return result.success === false;
      }),
      { numRuns: 100 },
    );
  });

  it('rejects every malformed payload for `switchOpenClashConfig`', () => {
    fc.assert(
      fc.property(malformedSwitchOpenClashConfigPayload, (payload) => {
        const result = desktopApiSchemas.switchOpenClashConfig.input.safeParse(
          payload,
        );
        return result.success === false;
      }),
      { numRuns: 100 },
    );
  });
});
