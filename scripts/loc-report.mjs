// Quick LOC report. Walks src/, prints per-file line counts grouped
// by category and the largest 30 files overall.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\//g, sep);
const SRC = join(ROOT, 'src');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|css|mjs)$/.test(entry)) acc.push(p);
  }
  return acc;
}

const files = walk(SRC);
const rows = files.map((p) => {
  const content = readFileSync(p, 'utf8');
  const lines = content.split('\n').length;
  return { path: relative(ROOT, p), lines };
});

// Categorise
const isTest = (p) => /\.test\.(ts|tsx)$/.test(p) || /\.pbt\.test\.(ts|tsx)$/.test(p);
const isCss = (p) => p.endsWith('.css');

const stats = (filter, label) => {
  const xs = rows.filter(filter);
  const total = xs.reduce((s, r) => s + r.lines, 0);
  console.log(`${label.padEnd(20)} files=${String(xs.length).padStart(4)}  lines=${String(total).padStart(7)}`);
};

console.log('--- Categories ---');
stats((r) => isTest(r.path), 'Tests');
stats((r) => !isTest(r.path) && isCss(r.path), 'CSS (production)');
stats((r) => !isTest(r.path) && r.path.includes(`renderer${sep}`) && !isCss(r.path), 'Renderer prod TS');
stats((r) => !isTest(r.path) && r.path.includes(`main${sep}`) && !isCss(r.path), 'Main prod TS');
stats((r) => !isTest(r.path) && r.path.includes(`preload${sep}`) && !isCss(r.path), 'Preload prod TS');
stats(() => true, 'Total');

console.log('\n--- Top 30 largest files ---');
rows.sort((a, b) => b.lines - a.lines).slice(0, 30).forEach((r) => {
  console.log(`${String(r.lines).padStart(5)}  ${r.path}`);
});

console.log('\n--- Top 15 CSS files ---');
rows.filter((r) => isCss(r.path)).sort((a, b) => b.lines - a.lines).slice(0, 15).forEach((r) => {
  console.log(`${String(r.lines).padStart(5)}  ${r.path}`);
});

console.log('\n--- Top 15 production (non-test, non-css) files ---');
rows.filter((r) => !isTest(r.path) && !isCss(r.path)).sort((a, b) => b.lines - a.lines).slice(0, 15).forEach((r) => {
  console.log(`${String(r.lines).padStart(5)}  ${r.path}`);
});
