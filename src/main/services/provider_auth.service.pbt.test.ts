// Feature: cpa-quota-import, Property 2
//
// Property 2: Service responses contain no token / API key substrings.
//
// Validates: Requirement 1.1, 1.4
//
// For any sequence of `importFromFile` calls with arbitrary CPA
// payloads where the access token, refresh token, and API key values
// are arbitrary unique strings, the `ProviderAuthMetadata` returned
// by `createProviderAuthService(...).importFromFile(...)` MUST
// satisfy:
//
//   1. `JSON.stringify(metadata)` contains neither the access-token
//      value, the refresh-token value, nor the API-key value as a
//      substring.
//   2. `metadata` carries no key from the set
//      `{ accessToken, refreshToken, apiKey, rawMetadata, rawAttributes }`.
//   3. `metadata.lastErrorMessage` is null or a string ≤ 80 chars.
//
// The redaction is structural — the {@link ProviderAuthMetadata}
// type literally lacks the five secret-bearing fields above and the
// service funnels every successful import through `redactRow(row)`
// (`provider_auth.service.ts`), which omits `secretKey` by
// projection. This property is therefore a regression guard against
// future drift: should `redactRow` ever copy a secret-bearing field
// into the metadata, every iteration with non-trivial token bodies
// would shrink to a counter-example.
//
// References:
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 1.1
//     (no token / API key in IPC return values)
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 1.4
//     (no token fragments in error messages or diagnostics output)
//   - .kiro/specs/cpa-quota-import/design.md §Property 2: Service
//     redaction-closure
//   - src/main/services/provider_auth.service.ts (`redactRow`,
//     `createProviderAuthService`)

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createProviderAuthService } from './provider_auth.service';
import type { ProviderAuthSecretPayload, ProviderId } from '../types';
import type {
  ProviderAuthRepository,
  ProviderAuthRow,
} from '../store/repositories';
import type { SecretsAdmin } from '../security/secrets.admin';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Closed `ProviderId` union (matches `types.ts` and `requirements.md`
// Requirement 4.1). Picking from the full set ensures every branch of
// `validateLightweight` runs at least once across `numRuns` iterations.
const PROVIDER_ID_ARB: fc.Arbitrary<ProviderId> = fc.constantFrom(
  'claude-code',
  'codex',
  'gemini-cli',
  'antigravity',
  'gemini-api',
  'deepseek',
  'xiaomi',
  'openai-compatible',
);

// Hex-only bodies keep the substring check deterministic — the JSON
// encoder never escapes hex characters, so `JSON.stringify(metadata)`
// will contain the literal token bytes verbatim if (and only if) the
// projection accidentally surfaces them. 24 hex chars = 96 bits of
// entropy, far above the 80-char `lastErrorMessage` budget so a
// truncated message could never accidentally embed the full token.
const HEX_BODY_ARB = fc.hexaString({ minLength: 24, maxLength: 24 });

// Short alphanum identifiers for `accountId` / `projectId`. Generated
// independently of the token bodies so a coincidental substring
// match is statistically irrelevant.
const ID_ARB = fc.hexaString({ minLength: 8, maxLength: 16 });

// ---------------------------------------------------------------------------
// In-memory test doubles
// ---------------------------------------------------------------------------

/**
 * In-memory `ProviderAuthRepository` mirroring the production
 * contract: ordered `list()` by `imported_at ASC`, `secretKey`
 * uniqueness, idempotent `remove`, no-op `update` for missing ids.
 * Mirrors the SQLite repository closely enough for a redaction
 * property — actual SQL semantics are pinned by `repositories.test.ts`
 * (task 2.4).
 */
function createInMemoryRepo(): ProviderAuthRepository {
  const rows = new Map<string, ProviderAuthRow>();
  return {
    list: () =>
      Array.from(rows.values()).sort((a, b) => a.importedAt - b.importedAt),
    listByProvider: (provider) =>
      Array.from(rows.values())
        .filter((r) => r.provider === provider)
        .sort((a, b) => a.importedAt - b.importedAt),
    get: (id) => rows.get(id) ?? null,
    insert: (row) => {
      if (rows.has(row.id)) {
        throw new Error(`duplicate id ${row.id}`);
      }
      for (const existing of rows.values()) {
        if (existing.secretKey === row.secretKey) {
          throw new Error('UNIQUE constraint failed: provider_auth.secret_key');
        }
      }
      rows.set(row.id, { ...row });
    },
    update: (id, patch) => {
      const existing = rows.get(id);
      if (!existing) return;
      rows.set(id, { ...existing, ...patch });
    },
    remove: (id) => {
      rows.delete(id);
    },
  };
}

/**
 * In-memory `SecretsAdmin` — accepts any key (the real admin enforces
 * the `cpaAuth.providerAuth.<uuid>` regex; relaxing it here lets the
 * property focus on redaction without coupling to UUID formatting).
 */
function createInMemorySecrets(): SecretsAdmin {
  const map = new Map<string, string>();
  return {
    set: (key, plaintext) => {
      map.set(key, plaintext);
    },
    get: (key) => map.get(key) ?? null,
    remove: (key) => {
      map.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('provider_auth.service — Property 2 (cpa-quota-import)', () => {
  it('returned metadata never contains the access / refresh token or API key as a substring', async () => {
    await fc.assert(
      fc.asyncProperty(
        PROVIDER_ID_ARB,
        HEX_BODY_ARB,
        HEX_BODY_ARB,
        HEX_BODY_ARB,
        ID_ARB,
        ID_ARB,
        async (
          provider,
          accessTokenBody,
          refreshTokenBody,
          apiKeyBody,
          accountId,
          projectId,
        ) => {
          // Prefix each generated value so a coincidental collision
          // with a label / accountId / projectId substring is
          // impossible — `AT_`, `RT_`, `AK_` are not produced by any
          // other generator in this file.
          const accessToken = `AT_${accessTokenBody}_END`;
          const refreshToken = `RT_${refreshTokenBody}_END`;
          const apiKey = `AK_${apiKeyBody}_END`;

          // Build a Secret_Payload that passes `validateLightweight`
          // for every provider in the closed `ProviderId` union:
          //   - `accessToken` non-empty (claude-code, codex,
          //     gemini-cli, antigravity);
          //   - `projectId` non-empty (gemini-cli, antigravity);
          //   - `apiKey` non-empty (gemini-api, deepseek, xiaomi,
          //     openai-compatible).
          //
          // `rawMetadata` / `rawAttributes` are populated with values
          // that *also* embed the secret bodies, so an accidental
          // copy of the verbatim metadata block into the redacted
          // projection would shrink to a counter-example as well.
          const payload: ProviderAuthSecretPayload = {
            accessToken,
            refreshToken,
            apiKey,
            accountId,
            projectId,
            rawMetadata: {
              embeddedAccessToken: accessToken,
              embeddedRefreshToken: refreshToken,
            },
            rawAttributes: {
              embeddedApiKey: apiKey,
            },
          };

          const repo = createInMemoryRepo();
          const secrets = createInMemorySecrets();
          let uuidCounter = 0;

          const service = createProviderAuthService({
            repo,
            secrets,
            // The dialog runs in main; the renderer never sees the
            // path. Returning a constant path is enough — the
            // service only reads `filePaths[0]` and treats it as
            // opaque.
            showOpenDialog: async () => ({
              canceled: false,
              filePaths: ['/tmp/cpa-import.json'],
            }),
            // Returned content is irrelevant because `parse` is
            // stubbed to ignore it.
            readFile: async () => '{}',
            statFile: async () => ({ size: 256 }),
            parse: () => ({
              label: `${provider}:imported`,
              accountId,
              projectId,
              payload,
            }),
            uuid: () => {
              uuidCounter += 1;
              const suffix = uuidCounter.toString(16).padStart(12, '0');
              return `00000000-0000-4000-8000-${suffix}`;
            },
            now: () => 1_700_000_000_000,
            // Disable the live Google userinfo lookup — the
            // property-based generator produces fake tokens, and a
            // real HTTP call would fail (often slowly, exceeding
            // the test timeout) for every shrunken case.
            fetchEmailForAccessToken: null,
          });

          const metadata = await service.importFromFile({ provider });

          // ----------------------------------------------------------------
          // Invariant 1: substring closure on the serialized form.
          //
          // Hex bodies + `_END` suffix never get JSON-escaped, so a
          // verbatim contains() check is sound.
          // ----------------------------------------------------------------
          const json = JSON.stringify(metadata);
          expect(json).not.toContain(accessToken);
          expect(json).not.toContain(refreshToken);
          expect(json).not.toContain(apiKey);

          // ----------------------------------------------------------------
          // Invariant 2: structural redaction — the projection literally
          // lacks every secret-bearing field name listed in
          // `design.md §Property 2`.
          // ----------------------------------------------------------------
          expect(metadata).not.toHaveProperty('accessToken');
          expect(metadata).not.toHaveProperty('refreshToken');
          expect(metadata).not.toHaveProperty('apiKey');
          expect(metadata).not.toHaveProperty('rawMetadata');
          expect(metadata).not.toHaveProperty('rawAttributes');
          // `secretKey` is the row-only column that points into the
          // `secrets` table; it must never escape via metadata.
          expect(metadata).not.toHaveProperty('secretKey');

          // ----------------------------------------------------------------
          // Invariant 3: bounded `lastErrorMessage` (Requirement 1.4).
          // ----------------------------------------------------------------
          if (metadata.lastErrorMessage !== null) {
            expect(metadata.lastErrorMessage.length).toBeLessThanOrEqual(80);
          }

          // The metadata is the value the IPC handler hands to the
          // renderer; subsequent `service.list()` calls return the
          // same redacted shape from storage. Verify both paths.
          const listed = service.list();
          expect(listed).toHaveLength(1);
          const listedJson = JSON.stringify(listed);
          expect(listedJson).not.toContain(accessToken);
          expect(listedJson).not.toContain(refreshToken);
          expect(listedJson).not.toContain(apiKey);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
