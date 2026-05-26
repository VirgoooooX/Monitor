// Feature: cpa-quota-import, Task 4.2
//
// Per-provider fixture coverage for `parseAuthFile` (the CPA auth file
// parser created in Task 4.1). One fixture per `ProviderId` exercises:
//
//   1. The happy path — parser returns the expected first-class fields
//      (`accessToken` / `apiKey` / `accountId` / `projectId`) and an
//      empty string is treated as absent (same rule as `findFirstString`).
//   2. The `metadata.access_token` priority — when both
//      `metadata.access_token = 'A'` and `access_token = 'B'` are
//      present, the parsed `accessToken` is `'A'`. (Requirement 7.1)
//   3. Missing `project_id` for Gemini CLI / Antigravity — the parser
//      itself is lenient and returns `projectId === null`; the
//      lightweight validate downstream is what flags `project_missing`.
//      (Requirement 7.4 + design.md §validateLightweight)
//   4. Redaction closure — for every fixture, `JSON.stringify(payload)`
//      contains no `prompt`, `response`, `messages`, or stray `cookie`
//      key (i.e. cookies that did not originate from the documented
//      `metadata.cookie` access-token source path). Property 1 will
//      cover this universally; this file pins the behaviour with
//      hand-crafted counter-examples that exercise each provider shape.
//
// References:
//   - cpa-quota-import/requirements.md Requirement 7.1, 7.2, 7.3, 7.4, 7.5
//   - cpa-quota-import/design.md §CPA auth file parser

import { describe, expect, it } from 'vitest';

import { parseAuthFile, ProviderAuthError } from './auth-file.parser';
import type { ProviderAuthSecretPayload, ProviderId } from '../types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Documented top-level keys of `ProviderAuthSecretPayload`. */
const ALLOWED_PAYLOAD_KEYS: ReadonlySet<keyof ProviderAuthSecretPayload> =
  new Set([
    'accessToken',
    'refreshToken',
    'apiKey',
    'accountId',
    'projectId',
    'expiresAt',
    'baseUrl',
    'rawMetadata',
    'rawAttributes',
  ]);

/**
 * Sentinel substrings that must NEVER appear as JSON keys in the
 * parsed payload regardless of provider. The check inspects keys
 * specifically (the `"key":` pattern in the serialized JSON), not raw
 * substrings, so a token value that happens to contain the word
 * "messages" does not produce a false positive.
 */
const FORBIDDEN_KEY_NAMES = [
  'prompt',
  'response',
  'messages',
  'cookie',
  'access_token',
  'refresh_token',
  'api_key',
  'id_token',
  'tokens',
] as const;

function assertPayloadShape(payload: ProviderAuthSecretPayload): void {
  for (const key of Object.keys(payload)) {
    expect(ALLOWED_PAYLOAD_KEYS.has(key as keyof ProviderAuthSecretPayload)).toBe(
      true,
    );
  }
  const json = JSON.stringify(payload);
  for (const banned of FORBIDDEN_KEY_NAMES) {
    // Match `"<banned>":` — the JSON-key form. Avoids false positives
    // on token *values* that happen to contain the substring.
    const pattern = new RegExp(`"${banned}"\\s*:`);
    expect(pattern.test(json)).toBe(false);
  }
}

function parse(provider: ProviderId, fixture: unknown) {
  return parseAuthFile(provider, JSON.stringify(fixture));
}

// ---------------------------------------------------------------------------
// claude-code
// ---------------------------------------------------------------------------

describe('parseAuthFile — claude-code', () => {
  const happyFixture = {
    access_token: 'sk-ant-oat01-AAAA',
    refresh_token: 'sk-ant-ort01-BBBB',
    expires_in: 3600,
    metadata: {
      account_id: 'acc_claude_xyz',
      scope: 'user:inference',
    },
  };

  it('extracts the first-class OAuth fields from a happy-path fixture', () => {
    const result = parse('claude-code', happyFixture);

    expect(result.payload.accessToken).toBe('sk-ant-oat01-AAAA');
    expect(result.payload.refreshToken).toBe('sk-ant-ort01-BBBB');
    expect(result.payload.accountId).toBe('acc_claude_xyz');
    expect(result.payload.projectId).toBeUndefined();
    expect(result.payload.expiresAt).toBeTypeOf('number');
    // Non-secret metadata survives in rawMetadata (scope is preserved
    // because it is not in the redacted-keys set).
    expect(result.payload.rawMetadata).toEqual({
      account_id: 'acc_claude_xyz',
      scope: 'user:inference',
    });
    expect(result.accountId).toBe('acc_claude_xyz');
    expect(result.projectId).toBeNull();

    assertPayloadShape(result.payload);
  });

  it('honours metadata.access_token priority over top-level access_token', () => {
    const result = parse('claude-code', {
      access_token: 'B',
      metadata: { access_token: 'A', account_id: 'acc_x' },
    });

    expect(result.payload.accessToken).toBe('A');
    assertPayloadShape(result.payload);
  });
});

// ---------------------------------------------------------------------------
// codex (ChatGPT)
// ---------------------------------------------------------------------------

describe('parseAuthFile — codex', () => {
  // Real CPA-exported Codex auth files surface the access token through
  // `metadata.access_token`; the `tokens.*` block is a CPA-internal
  // mirror used for refresh_token / account_id (those paths are in the
  // priority lists). We mirror that shape here.
  const happyFixture = {
    tokens: {
      access_token: 'eyJ-mirror',
      account_id: 'auth0|abc123',
      refresh_token: 'rt_codex_xyz',
    },
    metadata: {
      access_token: 'eyJ-canonical',
      account_id: 'auth0|abc123',
    },
  };

  it('prefers metadata.access_token and pulls account_id from priority paths', () => {
    const result = parse('codex', happyFixture);

    expect(result.payload.accessToken).toBe('eyJ-canonical');
    expect(result.payload.refreshToken).toBe('rt_codex_xyz');
    expect(result.payload.accountId).toBe('auth0|abc123');
    expect(result.accountId).toBe('auth0|abc123');

    assertPayloadShape(result.payload);
  });

  it('honours metadata.access_token priority over top-level access_token', () => {
    const result = parse('codex', {
      access_token: 'B',
      metadata: { access_token: 'A', account_id: 'auth0|x' },
    });

    expect(result.payload.accessToken).toBe('A');
    assertPayloadShape(result.payload);
  });
});

// ---------------------------------------------------------------------------
// gemini-cli
// ---------------------------------------------------------------------------

describe('parseAuthFile — gemini-cli', () => {
  const happyFixture = {
    access_token: 'ya29.gemini-AAAA',
    refresh_token: '1//04gemini-BBBB',
    expiry: '2025-01-01T00:00:00Z',
    metadata: {
      project_id: 'my-gcp-project-42',
    },
  };

  it('extracts access token, refresh token, project_id, and a numeric expiry', () => {
    const result = parse('gemini-cli', happyFixture);

    expect(result.payload.accessToken).toBe('ya29.gemini-AAAA');
    expect(result.payload.refreshToken).toBe('1//04gemini-BBBB');
    expect(result.payload.projectId).toBe('my-gcp-project-42');
    expect(result.payload.expiresAt).toBe(Date.parse('2025-01-01T00:00:00Z'));
    expect(result.projectId).toBe('my-gcp-project-42');

    assertPayloadShape(result.payload);
  });

  it('honours metadata.access_token priority over top-level access_token', () => {
    const result = parse('gemini-cli', {
      access_token: 'B',
      metadata: { access_token: 'A', project_id: 'p' },
    });

    expect(result.payload.accessToken).toBe('A');
    assertPayloadShape(result.payload);
  });

  it('still parses when project_id is missing — projectId is null', () => {
    // The parser is intentionally lenient: a missing project_id is the
    // lightweight validate's concern (`project_missing`), not the
    // parser's. The row is still importable.
    const fixture = {
      access_token: 'ya29.x',
      refresh_token: '1//y',
      expiry: '2025-01-01T00:00:00Z',
      metadata: {},
    };

    const result = parse('gemini-cli', fixture);

    expect(result.projectId).toBeNull();
    expect(result.payload.projectId).toBeUndefined();
    expect(result.payload.accessToken).toBe('ya29.x');
    assertPayloadShape(result.payload);
  });
});

// ---------------------------------------------------------------------------
// antigravity
// ---------------------------------------------------------------------------

describe('parseAuthFile — antigravity', () => {
  const happyFixture = {
    metadata: {
      access_token: 'ya29.antigravity-AAAA',
      refresh_token: '1//04antigravity-BBBB',
      project_id: 'antigravity-project-9',
      ideType: 'ANTIGRAVITY',
    },
  };

  it('extracts OAuth fields and project_id from metadata.*', () => {
    const result = parse('antigravity', happyFixture);

    expect(result.payload.accessToken).toBe('ya29.antigravity-AAAA');
    expect(result.payload.refreshToken).toBe('1//04antigravity-BBBB');
    expect(result.payload.projectId).toBe('antigravity-project-9');
    // Non-secret metadata fields (ideType, project_id) survive.
    expect(result.payload.rawMetadata).toEqual({
      project_id: 'antigravity-project-9',
      ideType: 'ANTIGRAVITY',
    });

    assertPayloadShape(result.payload);
  });

  it('honours metadata.access_token priority over top-level access_token', () => {
    const result = parse('antigravity', {
      access_token: 'B',
      metadata: {
        access_token: 'A',
        refresh_token: 'r',
        project_id: 'p',
      },
    });

    expect(result.payload.accessToken).toBe('A');
    assertPayloadShape(result.payload);
  });

  it('still parses when project_id is missing — projectId is null', () => {
    const fixture = {
      metadata: {
        access_token: 'ya29.x',
        refresh_token: '1//y',
        ideType: 'ANTIGRAVITY',
      },
    };

    const result = parse('antigravity', fixture);

    expect(result.projectId).toBeNull();
    expect(result.payload.projectId).toBeUndefined();
    expect(result.payload.accessToken).toBe('ya29.x');
    assertPayloadShape(result.payload);
  });
});

// ---------------------------------------------------------------------------
// gemini-api (plain API key — `attributes.api_key` priority)
// ---------------------------------------------------------------------------

describe('parseAuthFile — gemini-api', () => {
  it('extracts the API key from attributes.api_key (priority 1)', () => {
    const result = parse('gemini-api', {
      attributes: { api_key: 'AIzaSyGEMINI-AAAA' },
    });

    expect(result.payload.apiKey).toBe('AIzaSyGEMINI-AAAA');
    expect(result.payload.accessToken).toBeUndefined();
    // The api_key is stripped from rawAttributes (it's already
    // first-class on the payload), and the remaining attributes block
    // is empty → rawAttributes is undefined.
    expect(result.payload.rawAttributes).toBeUndefined();

    assertPayloadShape(result.payload);
  });

  it('extracts the API key from a top-level `api_key` (priority 2)', () => {
    const result = parse('gemini-api', { api_key: 'AIzaSyTOP' });

    expect(result.payload.apiKey).toBe('AIzaSyTOP');
    assertPayloadShape(result.payload);
  });
});

// ---------------------------------------------------------------------------
// deepseek (plain API key — top-level `api_key`)
// ---------------------------------------------------------------------------

describe('parseAuthFile — deepseek', () => {
  it('extracts the API key from a top-level api_key field', () => {
    const result = parse('deepseek', { api_key: 'sk-deepseek-AAAA' });

    expect(result.payload.apiKey).toBe('sk-deepseek-AAAA');
    expect(result.payload.accessToken).toBeUndefined();
    expect(result.payload.refreshToken).toBeUndefined();
    expect(result.accountId).toBeNull();
    expect(result.projectId).toBeNull();

    assertPayloadShape(result.payload);
  });
});

// ---------------------------------------------------------------------------
// Cross-provider redaction closure
// ---------------------------------------------------------------------------

describe('parseAuthFile — redaction closure (defensive)', () => {
  it('strips arbitrary `cookie` keys outside the access-token source path', () => {
    // `metadata.cookie` IS the documented access-token source path
    // (priority 7 of ACCESS_TOKEN_PATHS) — it gets promoted to
    // `payload.accessToken`. But unrelated `cookie` keys nested deeper
    // in metadata, or anywhere in attributes, must be stripped from
    // the surviving raw* blocks.
    const result = parse('openai-compatible', {
      access_token: 'tok-real',
      metadata: {
        cookie: 'session=should-NOT-be-promoted-because-access_token-is-set',
        nested: { cookie: 'leaked-cookie' },
        ok_field: 'preserved',
      },
      attributes: {
        api_key: 'sk-fallback',
        cookie: 'leaked-attr-cookie',
        ok_attr: 'preserved',
      },
    });

    // metadata.access_token > metadata.cookie, so cookie is NOT
    // promoted. accessToken comes from the top-level access_token.
    expect(result.payload.accessToken).toBe('tok-real');
    expect(result.payload.apiKey).toBe('sk-fallback');

    // No `cookie` key survives anywhere in the serialized payload —
    // not at the top, not in rawMetadata, not in rawAttributes,
    // not under `metadata.nested`.
    const json = JSON.stringify(result.payload);
    expect(/"cookie"\s*:/.test(json)).toBe(false);
    expect(json).not.toContain('leaked-cookie');
    expect(json).not.toContain('leaked-attr-cookie');

    // Non-secret siblings survive.
    expect(result.payload.rawMetadata).toMatchObject({
      ok_field: 'preserved',
      nested: {},
    });
    expect(result.payload.rawAttributes).toMatchObject({
      ok_attr: 'preserved',
    });

    assertPayloadShape(result.payload);
  });

  it('strips chat-content sibling keys (prompt / response / messages)', () => {
    // Defense-in-depth: even if a CPA export accidentally embeds chat
    // payload fragments next to the auth fields, the parser must not
    // surface those keys in `rawMetadata` / `rawAttributes`.
    const result = parse('claude-code', {
      access_token: 'sk-ant-oat01-x',
      metadata: {
        account_id: 'acc',
        prompt: 'leaked prompt content',
        response: 'leaked response content',
        messages: [{ role: 'user', content: 'leaked' }],
      },
    });

    const json = JSON.stringify(result.payload);
    expect(/"prompt"\s*:/.test(json)).toBe(false);
    expect(/"response"\s*:/.test(json)).toBe(false);
    expect(/"messages"\s*:/.test(json)).toBe(false);
    expect(json).not.toContain('leaked prompt content');
    expect(json).not.toContain('leaked response content');

    assertPayloadShape(result.payload);
  });
});

// ---------------------------------------------------------------------------
// Negative cases (sanity checks for the structural invariants the
// rest of this file relies on)
// ---------------------------------------------------------------------------

describe('parseAuthFile — error handling', () => {
  it('rejects invalid JSON with a parse_error code', () => {
    expect(() => parseAuthFile('claude-code', 'not json')).toThrow(
      ProviderAuthError,
    );
    try {
      parseAuthFile('claude-code', 'not json');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderAuthError);
      expect((err as ProviderAuthError).code).toBe('parse_error');
    }
  });

  it('rejects a non-object top-level value', () => {
    expect(() => parseAuthFile('deepseek', '"a-string"')).toThrow(
      ProviderAuthError,
    );
  });

  it('rejects a payload with neither token nor api_key', () => {
    expect(() =>
      parseAuthFile('claude-code', JSON.stringify({ metadata: { foo: 'bar' } })),
    ).toThrow(ProviderAuthError);
  });
});
