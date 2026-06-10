#!/usr/bin/env node
// Build-time validator for the i18n-multilingual-support feature.
//
// Source of truth: .kiro/specs/i18n-multilingual-support/{requirements,design}.md
// Task: 16.1 (tasks.md).
//
// Source-time checks (always run, no flags):
//   1. Key-set equality between zh-CN and en-US catalogs
//      (Requirement 3.3 — symmetric difference is empty).
//   2. Value invariants per Requirement 3.4:
//        typeof v === 'string', v.trim().length >= 1, v.length <= 500.
//   3. No-CJK-untranslated rule per Requirement 3.5: when the zh-CN
//      value contains at least one code point in U+4E00..U+9FFF or
//      U+3400..U+4DBF, the en-US counterpart MUST differ byte-for-byte.
//      Exempt: values whose zh-CN counterpart is exclusively ASCII
//      digits, ASCII punctuation, or whitespace.
//
// Bundle backstop check (--check-bundle, after tsc + vite build):
//   4. Diff catalog object literals between the main bundle
//      (dist/main/i18n/catalogs/{zh-CN,en-US}.js) and the renderer
//      bundle (dist/renderer/assets/*.js) against the source catalogs
//      to enforce Requirement 3.6 byte-equality of corresponding
//      Translation_Keys across both builds. Failure of any of these
//      tiers exits non-zero with a structured violation list naming
//      the offending Locale_Code and Translation_Key (Requirement 3.8).
//
// Usage:
//   node scripts/validate-i18n-catalogs.mjs              # source-time only
//   node scripts/validate-i18n-catalogs.mjs --check-bundle # + bundle diff

import { tsImport } from 'tsx/esm/api';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// CJK code-point ranges from Requirement 3.5 (Unified Ideographs +
// Extension A) plus Requirement 4.1's Symbols & Punctuation block.
// 3.5 only consults Unified + Extension A for the untranslated check.
const CJK_UNTRANSLATED_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

// ASCII digits + ASCII punctuation + whitespace — the exemption set
// from Requirement 3.5. Match a value composed exclusively of these
// code points (any length, including empty — empty values are caught
// by the trimmed-length invariant elsewhere).
//   digits    U+0030..U+0039
//   punct A   U+0021..U+002F
//   punct B   U+003A..U+0040
//   punct C   U+005B..U+0060
//   punct D   U+007B..U+007E
//   \s covers tab, LF, CR, FF, regular space, NBSP, etc.
const EXEMPT_RE = /^[\u0021-\u002f\u0030-\u0039\u003a-\u0040\u005b-\u0060\u007b-\u007e\s]*$/;

const SOURCE_ZH = path.join(ROOT, 'src', 'i18n', 'catalogs', 'zh-CN.ts');
const SOURCE_EN = path.join(ROOT, 'src', 'i18n', 'catalogs', 'en-US.ts');
const DIST_MAIN_ZH = path.join(ROOT, 'dist', 'i18n', 'catalogs', 'zh-CN.js');
const DIST_MAIN_EN = path.join(ROOT, 'dist', 'i18n', 'catalogs', 'en-US.js');
const DIST_RENDERER_ASSETS = path.join(ROOT, 'dist', 'renderer', 'assets');

/** @type {{ locale: string, key: string, message: string }[]} */
const violations = [];

function record(locale, key, message) {
  violations.push({ locale, key, message });
}

async function loadSourceCatalogs() {
  const parent = import.meta.url;
  const zhMod = await tsImport(pathToFileURL(SOURCE_ZH).href, parent);
  const enMod = await tsImport(pathToFileURL(SOURCE_EN).href, parent);
  const zhCN = zhMod.zhCN;
  const enUS = enMod.enUS;
  if (!zhCN || typeof zhCN !== 'object') {
    throw new Error(`failed to load src/i18n/catalogs/zh-CN.ts: missing 'zhCN' export`);
  }
  if (!enUS || typeof enUS !== 'object') {
    throw new Error(`failed to load src/i18n/catalogs/en-US.ts: missing 'enUS' export`);
  }
  return { zhCN, enUS };
}

function checkKeySymmetry(zhCN, enUS) {
  // Sorted UTF-8 string arrays per Requirement 12.1 / task 16.1.
  const zhKeys = Object.keys(zhCN).sort();
  const enKeys = Object.keys(enUS).sort();
  const zhSet = new Set(zhKeys);
  const enSet = new Set(enKeys);
  for (const k of zhKeys) {
    if (!enSet.has(k)) {
      record('en-US', k, 'key present in zh-CN but absent from en-US (symmetric-difference violation)');
    }
  }
  for (const k of enKeys) {
    if (!zhSet.has(k)) {
      record('zh-CN', k, 'key present in en-US but absent from zh-CN (symmetric-difference violation)');
    }
  }
}

function checkValueInvariants(locale, catalog) {
  for (const [k, v] of Object.entries(catalog)) {
    if (typeof v !== 'string') {
      record(locale, k, `value typeof === '${typeof v}' (expected 'string')`);
      continue;
    }
    if (v.trim().length < 1) {
      record(locale, k, 'value is empty or whitespace-only after trim()');
    }
    if (v.length > 500) {
      record(locale, k, `value length ${v.length} exceeds 500-character ceiling`);
    }
  }
}

function checkNoCjkUntranslated(zhCN, enUS) {
  // Iterate the intersection of keys; symmetry violations are reported
  // separately by checkKeySymmetry so this loop ignores asymmetric
  // entries.
  for (const k of Object.keys(zhCN)) {
    const zhVal = zhCN[k];
    const enVal = enUS[k];
    if (typeof zhVal !== 'string' || typeof enVal !== 'string') continue;
    if (!CJK_UNTRANSLATED_RE.test(zhVal)) continue;     // no CJK -> rule N/A
    if (EXEMPT_RE.test(zhVal)) continue;                // ascii-only -> exempt
    if (enVal === zhVal) {
      record(
        'en-US',
        k,
        `en-US value byte-identical to zh-CN value (${JSON.stringify(zhVal)}) despite zh-CN containing CJK; Requirement 3.5 requires a translation`,
      );
    }
  }
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function checkMainBundle(srcZh, srcEn) {
  const haveZh = await pathExists(DIST_MAIN_ZH);
  const haveEn = await pathExists(DIST_MAIN_EN);
  if (!haveZh || !haveEn) {
    record(
      'build',
      '<main-bundle>',
      `dist/main/i18n/catalogs/{zh-CN,en-US}.js not found — run \`tsc -p tsconfig.main.json\` before --check-bundle`,
    );
    return null;
  }
  const zhMod = await import(pathToFileURL(DIST_MAIN_ZH).href);
  const enMod = await import(pathToFileURL(DIST_MAIN_EN).href);
  const distZh = zhMod.zhCN;
  const distEn = enMod.enUS;
  if (!distZh || typeof distZh !== 'object') {
    record('build', '<main-bundle>', `dist/main/i18n/catalogs/zh-CN.js missing 'zhCN' export`);
    return null;
  }
  if (!distEn || typeof distEn !== 'object') {
    record('build', '<main-bundle>', `dist/main/i18n/catalogs/en-US.js missing 'enUS' export`);
    return null;
  }
  for (const [k, srcVal] of Object.entries(srcZh)) {
    const distVal = distZh[k];
    if (distVal !== srcVal) {
      record(
        'zh-CN',
        k,
        `main-bundle value diverges from source: src=${JSON.stringify(srcVal)} dist=${JSON.stringify(distVal)}`,
      );
    }
  }
  for (const [k, srcVal] of Object.entries(srcEn)) {
    const distVal = distEn[k];
    if (distVal !== srcVal) {
      record(
        'en-US',
        k,
        `main-bundle value diverges from source: src=${JSON.stringify(srcVal)} dist=${JSON.stringify(distVal)}`,
      );
    }
  }
  return { distZh, distEn };
}

async function checkRendererBundle(srcZh, srcEn) {
  if (!(await pathExists(DIST_RENDERER_ASSETS))) {
    record(
      'build',
      '<renderer-bundle>',
      `dist/renderer/assets not found — run \`vite build\` before --check-bundle`,
    );
    return;
  }
  const entries = await fs.readdir(DIST_RENDERER_ASSETS);
  const jsFiles = entries.filter((n) => n.endsWith('.js'));
  if (jsFiles.length === 0) {
    record('build', '<renderer-bundle>', 'no .js chunks under dist/renderer/assets');
    return;
  }
  const blobs = await Promise.all(
    jsFiles.map((n) => fs.readFile(path.join(DIST_RENDERER_ASSETS, n), 'utf8')),
  );
  const haystack = blobs.join('\n');
  // The renderer bundle is minified JS. Property names of object
  // literals are preserved as string literals by both esbuild and
  // terser, and Vite preserves UTF-8 source bytes (no \uXXXX escape
  // expansion). For each catalog (locale, key) pair we assert the
  // value appears as a contiguous substring of the bundle. A pair of
  // raw + JSON-escaped probes is checked so values containing JSON
  // metacharacters (`"`, `\`, control chars) still resolve when the
  // minifier emits them in escaped form. Both probes failing means
  // the value is provably absent.
  for (const [k, v] of Object.entries(srcZh)) {
    if (typeof v !== 'string') continue;
    if (!bundleContainsValue(haystack, v)) {
      record('zh-CN', k, `value ${JSON.stringify(v)} not found in any dist/renderer/assets/*.js chunk`);
    }
  }
  for (const [k, v] of Object.entries(srcEn)) {
    if (typeof v !== 'string') continue;
    if (!bundleContainsValue(haystack, v)) {
      record('en-US', k, `value ${JSON.stringify(v)} not found in any dist/renderer/assets/*.js chunk`);
    }
  }
}

function bundleContainsValue(haystack, value) {
  if (haystack.includes(value)) return true;
  // JSON.stringify wraps in quotes; strip them, leaving the escaped
  // body. Probes the case where the minifier kept the value in a
  // double-quoted string literal with metacharacters escaped.
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value && haystack.includes(escaped)) return true;
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const checkBundleFlag = args.includes('--check-bundle');
  for (const a of args) {
    if (a !== '--check-bundle') {
      console.error(`unknown argument: ${a}`);
      console.error('usage: node scripts/validate-i18n-catalogs.mjs [--check-bundle]');
      process.exit(2);
    }
  }

  /** @type {Record<string, string>} */
  let zhCN;
  /** @type {Record<string, string>} */
  let enUS;
  try {
    ({ zhCN, enUS } = await loadSourceCatalogs());
  } catch (err) {
    console.error(`✗ i18n catalog validator: failed to load source catalogs`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  checkKeySymmetry(zhCN, enUS);
  checkValueInvariants('zh-CN', zhCN);
  checkValueInvariants('en-US', enUS);
  checkNoCjkUntranslated(zhCN, enUS);

  if (checkBundleFlag) {
    await checkMainBundle(zhCN, enUS);
    await checkRendererBundle(zhCN, enUS);
  }

  if (violations.length === 0) {
    const keyCount = Object.keys(zhCN).length;
    const tier = checkBundleFlag ? 'source + bundle' : 'source';
    console.log(`✓ i18n catalog validation passed (${keyCount} keys × 2 locales, ${tier})`);
    process.exit(0);
  }

  console.error(`✗ i18n catalog validation failed: ${violations.length} violation(s)`);
  for (const v of violations) {
    console.error(`  [${v.locale}] ${v.key}: ${v.message}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('i18n catalog validator crashed:', err);
  process.exit(2);
});
