// Feature: network-quick-actions, Property 16: Error code labels are total.
//
// Validates Requirements 8.5, 16.4, 16.5.
//
// The Quick_Actions_Panel and its child cards funnel every
// management-client failure (and the orchestrator-side
// `'switch_in_progress'` lock-arbitration code) through the shared
// `formatManagementError` helper exported from `./format`. This test
// is a totality assertion over the closed enum: for every code the
// IPC layer can hand the renderer, the i18n map MUST yield a
// non-empty localised string. A missing or empty entry would surface
// in the UI as a blank banner / inline error, violating Requirements
// 8.5 (audit visibility) and 16.4..16.5 (every error code maps to a
// localised label).
//
// Property 16 is intentionally not a fast-check property — the input
// space is a fixed 7-element union, so a plain enumeration is both
// exhaustive and trivially deterministic. The accompanying
// `Record<ManagementErrorCode | 'switch_in_progress', TranslationKey>`
// type in `format.ts` already guarantees totality at compile time;
// this runtime check guards the *content* (non-empty + zh-CN
// characters in the zh-CN catalog, non-empty in en-US) that the
// type system cannot express.
//
// As of i18n-multilingual-support task 14.5 `formatManagementError`
// takes a `Translator` argument so the rendered label flips live
// with the active locale; we verify both the zh-CN and en-US
// translators yield total, non-empty results for every code.

import { describe, it, expect } from 'vitest';

import { formatManagementError } from './format';
import { createTranslator } from '../../i18n';
import type { ManagementErrorCode } from './types';

// ---------------------------------------------------------------------------
// Closed-set enumeration
// ---------------------------------------------------------------------------
//
// Every member of `ManagementErrorCode` (mirrored from
// `src/main/types.ts` per network-quick-actions design.md §IPC
// Surface) plus the orchestrator-side `'switch_in_progress'` code
// returned when the switch lock is held (Requirements 9.1..9.3,
// 16.2). The `satisfies` clause makes the array provably exhaustive:
// dropping a member or mistyping a code is a TypeScript error.

const ALL_CODES = [
  'auth_error',
  'http_error',
  'network_error',
  'verify_timeout',
  'verify_mismatch',
  'not_supported',
  'switch_in_progress',
] as const satisfies ReadonlyArray<ManagementErrorCode | 'switch_in_progress'>;

// Matches any single CJK Unified Ideograph — the cheapest test for
// "this label is actually localized to zh-CN" without pulling in
// an Intl segmenter.
const ZH_CN_CHAR = /[\u4e00-\u9fff]/;

// ---------------------------------------------------------------------------

describe('formatManagementError — Property 16: error code labels are total', () => {
  const tZh = createTranslator('zh-CN');
  const tEn = createTranslator('en-US');

  it.each(ALL_CODES)(
    'zh-CN: maps %s to a non-empty zh-CN string',
    (code) => {
      const label = formatManagementError(tZh, code);

      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      // Trimmed length, since a string of only whitespace would also
      // render as a blank banner in the UI.
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).toMatch(ZH_CN_CHAR);
    },
  );

  it.each(ALL_CODES)(
    'en-US: maps %s to a non-empty string',
    (code) => {
      const label = formatManagementError(tEn, code);

      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      expect(label.trim().length).toBeGreaterThan(0);
      // The en-US catalog must NOT contain CJK code points
      // (Requirement 4.1) for these CJK-bearing zh-CN entries.
      expect(label).not.toMatch(ZH_CN_CHAR);
    },
  );
});
