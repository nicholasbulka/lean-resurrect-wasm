#!/usr/bin/env node
// Run diff.mjs over the LiCriterion corpus and aggregate scores.
//
// Usage:  node run-corpus.mjs [<corpus-root>]
// Default corpus root is the LiCriterion project on disk.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = '/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion';

const root = process.argv[2] ?? DEFAULT_ROOT;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.lake' || entry.name === '.git') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (p.endsWith('.lean')) yield p;
  }
}

const files = [...walk(root)].sort((a, b) => statSync(a).size - statSync(b).size);
console.error(`Running diff on ${files.length} files in ${root}`);

let totals = { bytes: 0, leanCovBytes: 0, lezerCovBytes: 0, leanScored: 0, leanAgreed: 0, files: 0, errors: 0 };
const totalConfusion = new Map();
const worst = [];

for (const file of files) {
  const r = spawnSync('node', [join(__dirname, 'diff.mjs'), file], { encoding: 'utf8' });
  if (r.status !== 0) {
    totals.errors++;
    console.error(`[fail] ${relative(root, file)}: exit=${r.status}`);
    continue;
  }
  let result;
  try { result = JSON.parse(r.stdout); } catch (e) {
    totals.errors++;
    console.error(`[parse-fail] ${relative(root, file)}`);
    continue;
  }
  totals.files++;
  totals.bytes += result.bytes;
  totals.leanCovBytes += result.leanCovBytes;
  totals.lezerCovBytes += result.lezerCovBytes;
  totals.leanScored += result.leanScored;
  totals.leanAgreed += result.leanAgreed;
  for (const [k, v] of Object.entries(result.confusion ?? {})) {
    totalConfusion.set(k, (totalConfusion.get(k) ?? 0) + v);
  }
  const acc = result.leanScored ? (result.leanAgreed / result.leanScored) * 100 : 100;
  if (acc < 99 && result.leanScored > 50) worst.push({ file: relative(root, file), acc: acc.toFixed(2), scored: result.leanScored, top: Object.entries(result.confusion ?? {}).slice(0, 3) });
}

worst.sort((a, b) => parseFloat(a.acc) - parseFloat(b.acc));

console.log('\n=== CORPUS SUMMARY ===');
console.log(JSON.stringify({
  files: totals.files,
  errors: totals.errors,
  totalBytes: totals.bytes,
  leanCovPct: ((totals.leanCovBytes / totals.bytes) * 100).toFixed(1),
  lezerCovPct: ((totals.lezerCovBytes / totals.bytes) * 100).toFixed(1),
  overallAccuracyPct: totals.leanScored ? ((totals.leanAgreed / totals.leanScored) * 100).toFixed(2) : 'N/A',
  totalConfusion: Object.fromEntries([...totalConfusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
}, null, 2));

if (worst.length) {
  console.log('\n=== WORST 10 FILES (acc < 99%) ===');
  for (const w of worst.slice(0, 10)) console.log(JSON.stringify(w));
}
