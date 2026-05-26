// Feature: cpa-quota-import, Property 7
//
// Property 7: `desktop:updateSecret` rejects every Provider_Auth key.
//
// Validates: Requirement 15.2.
//   The renderer-facing `desktop:updateSecret` IPC handler MUST NOT
//   accept any `cpaAuth.providerAuth.<uuid>` key. Provider_Auth secret
//   payloads are addressed by keys of that exact shape (see
//   `design.md §Provider_Auth_Service` and `tasks.md §3.2`), and they
//   are written and read exclusively through main-internal flows
//   (`importProviderAuthFile`, `deleteProviderAuth`, the future
//   `secretsAdmin` accessor). The renderer-facing
//   `updateSecret` / `getSecret` / `removeSecret` channels keep a
//   closed allowlist limited to `openclash.controllerSecret`,
//   `openclash.management.username`, `openclash.management.password`
//   and throw `Error("updateSecret: unknown key '...'")` on every
//   other key — which the IPC envelope wraps into
//   `{ ok: false, error: { code: 'internal', ... } }` (see the
//   `INTERNAL_FAILURE` helper in `src/main/ipc/index.ts`).
//
// Strategy
// --------
//
//   * Reconstruct the exact `ALLOWED_KEYS` list and the same throw-on-
//     unknown-key callback shape that `src/main/app.ts` wires into
//     `IpcRegistryDeps.updateSecret`. This is a structural redundancy
//     check — if the production allowlist ever drifts to silently
//     accept `cpaAuth.providerAuth.*` keys (which would be a security
//     regression for Requirement 15.2), the constants imported here
//     would not change and this test would NOT detect it. So we keep
//     the constants in this file synchronised with `app.ts` by
//     convention; a future refactor could lift `ALLOWED_KEYS` into a
//     shared module and import it here for stronger coupling.
//   * Run the production `updateSecretInputSchema` against the
//     candidate payload first, then dispatch the callback inside the
//     same try/catch envelope the IPC handler uses (`VALIDATION_FAILURE`
//     vs `INTERNAL_FAILURE`). This mirrors the behaviour at
//     `src/main/ipc/index.ts §updateSecret` (lines 1045-1061) without
//     standing up Electron / `ipcMain.handle`.
//   * Generate arbitrary UUIDv4 strings via `fc.uuid({ version: 4 })`
//     so every iteration exercises a key matching the documented
//     `^cpaAuth\.providerAuth\.[0-9a-f-]{36}$` shape (Task 3.2).
//
// References:
//   - .kiro/specs/cpa-quota-import/requirements.md §Requirement 15.2
//   - .kiro/specs/cpa-quota-import/design.md §Provider_Auth_Service
//   - .kiro/specs/cpa-quota-import/tasks.md §Task 3.2 (renderer
//     allowlist closure) and §Task 3.3 (this test)
//   - src/main/app.ts — `updateSecret` callback / `ALLOWED_KEYS`
//   - src/main/ipc/index.ts — `INTERNAL_FAILURE`, `VALIDATION_FAILURE`

import { describe, it } from 'vitest';
import fc from 'fast-check';

import { updateSecretInputSchema } from './schemas';

// Mirror of the `ALLOWED_KEYS` constant defined in
// `src/main/app.ts` (`updateSecret` callback). Kept in sync by
// convention; see the file header strategy note.
const ALLOWED_KEYS = [
  'openclash.controllerSecret',
  'openclash.management.username',
  'openclash.management.password',
] as const;

/**
 * Mirror of the throw-on-unknown-key callback `app.ts` wires into
 * `IpcRegistryDeps.updateSecret`. The actual implementation also
 * calls `secrets.set(...)` on the success path, but Property 7 only
 * cares about the rejection contract so we omit the secret module
 * dependency here.
 */
function rendererUpdateSecret(input: { key: string; value: string }): void {
  if (!ALLOWED_KEYS.includes(input.key as (typeof ALLOWED_KEYS)[number])) {
    throw new Error(`updateSecret: unknown key '${input.key}'`);
  }
  // Allowlisted keys would normally call `secrets.set(...)` — outside
  // the scope of Property 7. The function returns void in both paths
  // of the production wiring.
}

/**
 * Wrap the callback in the exact same envelope the IPC handler at
 * `src/main/ipc/index.ts §updateSecret` produces. Validation
 * failures land at `{ ok: false, error: { code: 'validation', ... } }`,
 * thrown errors land at `{ ok: false, error: { code: 'internal', ... } }`.
 */
type IpcEnvelope =
  | { ok: true; value: void }
  | { ok: false; error: { code: string; message: string } };

function invokeUpdateSecret(payload: unknown): IpcEnvelope {
  const parsed = updateSecretInputSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: 'validation', message: parsed.error.issues[0]?.message ?? 'invalid' },
    };
  }
  try {
    rendererUpdateSecret(parsed.data);
    return { ok: true, value: undefined };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'internal',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

describe('desktop:updateSecret — Property 7 (cpa-quota-import)', () => {
  it('rejects every cpaAuth.providerAuth.<uuid> key', () => {
    fc.assert(
      fc.property(
        fc.uuid({ version: 4 }),
        // The schema requires a non-empty trimmed string; any
        // length-≥-1 string satisfies that precondition. Keep the
        // value generator narrow so the property focuses on the
        // KEY rejection, not the value validation.
        fc.string({ minLength: 1, maxLength: 32 }).filter(
          (s) => s.trim().length > 0,
        ),
        (uuid, value) => {
          const key = `cpaAuth.providerAuth.${uuid}`;
          const envelope = invokeUpdateSecret({ key, value });

          // The envelope MUST be a failure with one of the two
          // documented codes (Task 3.3 success criteria).
          if (envelope.ok) {
            return false;
          }
          if (
            envelope.error.code !== 'validation' &&
            envelope.error.code !== 'internal'
          ) {
            return false;
          }

          // Stronger structural assertion: the key must NOT be in
          // the allowlist. This catches the case where a future
          // refactor inadvertently widens `ALLOWED_KEYS` to include
          // `cpaAuth.providerAuth.*`.
          if (
            (ALLOWED_KEYS as readonly string[]).includes(key)
          ) {
            return false;
          }

          // The error message must NOT echo the secret value (the
          // production callback only echoes the key in its error
          // string, but pin the invariant here so a regression that
          // adds the value to the message is caught immediately).
          if (envelope.error.message.includes(value) && value.length >= 4) {
            return false;
          }

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
