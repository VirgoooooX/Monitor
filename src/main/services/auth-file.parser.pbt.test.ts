// Feature: cpa-quota-import, Property 1
//
// Property 1: Parsed payload contains no `prompt|response|messages` content.
//
// Validates: Requirement 1.4, 7.8.
//
// For any CPA-shaped JSON containing at least one `access_token` so
// `parseAuthFile()` does not throw, the parser MUST strip every key
// named `prompt`, `response`, or `messages` from the persisted Secret
// Payload — even when those keys appear nested arbitrarily deep
// inside the `metadata` or `attributes` blocks. The closure also
// covers the secret-key names (`access_token`, `refresh_token`,
// `token`, `id_token`, `cookie`, `api_key`, `key`, `tokens`) that
// `auth-file.parser.ts#REDACTED_KEY_NAMES` already strips for the
// duplicate-storage invariant; this property focuses on the
// chat-content half called for by Requirement 1.4 / 7.8.
//
// We assert structurally by serialising `parsed.payload` and checking
// that the JSON output does not contain the substrings
// `'"prompt":'`, `'"response":'`, or `'"messages":'`. Those forms
// match only the JSON KEY occurrence (the trailing colon is what
// JSON.stringify always emits after a key); a string VALUE that
// happens to embed the word `prompt` would be escaped as
// `"\"prompt\": ..."` and would not produce the literal
// `"prompt":` substring.
//
// References:
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 1.4
//     (no chat-content fragments leak into IPC / diagnostics output)
//   - .kiro/specs/cpa-quota-import/requirements.md Requirement 7.8
//     (parse errors / payloads do not echo raw input)
//   - .kiro/specs/cpa-quota-import/design.md §CPA auth file parser
//   - src/main/services/auth-file.parser.ts (`REDACTED_KEY_NAMES`,
//     `deepStrip`, `stripBlock`)

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseAuthFile } from './auth-file.parser';

// ---------------------------------------------------------------------------
// Substrings the property forbids in the serialized payload. Each is the
// JSON.stringify form of the corresponding KEY (always followed by `:`),
// so a primitive string VALUE that embeds the word `prompt` will never
// produce a false positive — its quotes are escaped.
// ---------------------------------------------------------------------------

const FORBIDDEN_KEY_PATTERNS = ['"prompt":', '"response":', '"messages":'];

// ---------------------------------------------------------------------------
// Key arbitrary biased toward chat-content names so each generated
// nested object is likely to contain at least one `prompt` /
// `response` / `messages` key. The non-chat names are mixed in so
// stripping is verified in the presence of arbitrary siblings.
// ---------------------------------------------------------------------------

const KEY_ARB = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('prompt', 'response', 'messages') },
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'extra',
      'data',
      'session',
      'context',
      'scope',
      'foo',
      'bar',
      'baz',
    ),
  },
);

// Primitive leaves. Keep strings short and free of structural JSON
// characters so the synthesised object always serialises cleanly.
const PRIMITIVE_ARB: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

// Recursive object/array generator. `fc.letrec` automatically applies
// a depth bias; the weights additionally bias each step toward
// primitives so generation terminates with high probability.
const { jsonValue } = fc.letrec<{ jsonValue: unknown }>((tie) => ({
  jsonValue: fc.oneof(
    { weight: 5, arbitrary: PRIMITIVE_ARB },
    {
      weight: 2,
      arbitrary: fc.dictionary(KEY_ARB, tie('jsonValue'), { maxKeys: 4 }),
    },
    {
      weight: 1,
      arbitrary: fc.array(tie('jsonValue'), { maxLength: 3 }),
    },
  ),
}));

// Object arbitrary specifically for `metadata` / `attributes` blocks
// so the generated value is always a plain object (the parser only
// retains a block when it is a plain object). Chat-content keys may
// appear at the top level of the block as well as nested.
const BLOCK_ARB: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  KEY_ARB,
  jsonValue,
  { maxKeys: 5 },
);

// Top-level CPA-shaped object. `access_token` is required so the
// parser's "at least one of accessToken / apiKey" guard succeeds and
// we exercise the full payload-construction path. The token value is
// constrained to non-whitespace ASCII so `findFirstString` accepts it
// on the first try.
const NON_EMPTY_TOKEN_ARB = fc
  .string({ minLength: 5, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

const CPA_OBJECT_ARB = fc.record(
  {
    metadata: BLOCK_ARB,
    attributes: BLOCK_ARB,
    // Top-level chat-content keys to confirm the parser's selective
    // extraction never copies them into the payload (it only stores
    // the documented Secret Payload fields plus the deep-stripped
    // metadata / attributes blocks).
    prompt: jsonValue,
    response: jsonValue,
    messages: jsonValue,
    access_token: NON_EMPTY_TOKEN_ARB,
  },
  { requiredKeys: ['metadata', 'attributes', 'access_token'] },
);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('auth-file.parser — Property 1 (cpa-quota-import)', () => {
  it('parsed payload contains no prompt/response/messages keys', () => {
    fc.assert(
      fc.property(CPA_OBJECT_ARB, (raw) => {
        const parsed = parseAuthFile('claude-code', JSON.stringify(raw));
        const serialized = JSON.stringify(parsed.payload);
        for (const pattern of FORBIDDEN_KEY_PATTERNS) {
          expect(serialized).not.toContain(pattern);
        }
      }),
      { numRuns: 100 },
    );
  });
});
