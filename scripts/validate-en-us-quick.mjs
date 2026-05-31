// Throwaway validation harness for task 1.3. Loaded via tsx so the
// TypeScript catalog resolves without a dedicated build step.
// Deletable once the official validator (task 16) lands.

const { enUS } = await import('../src/i18n/catalogs/en-US.ts');

const keys = Object.keys(enUS);
console.log('total keys:', keys.length);

const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff]/;
let bad = 0;
for (const k of keys) {
  const v = enUS[k];
  if (typeof v !== 'string') {
    console.log('NOT STRING', k, typeof v);
    bad++;
    continue;
  }
  if (v.trim().length < 1) {
    console.log('EMPTY/TRIMMED', k, JSON.stringify(v));
    bad++;
    continue;
  }
  if (v.length > 500) {
    console.log('OVER 500', k, v.length);
    bad++;
    continue;
  }
  if (CJK_RE.test(v)) {
    console.log('CJK FOUND', k, JSON.stringify(v));
    bad++;
    continue;
  }
}

console.log('violations:', bad);
process.exit(bad === 0 ? 0 : 1);
