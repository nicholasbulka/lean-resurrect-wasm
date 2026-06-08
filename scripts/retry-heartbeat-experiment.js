#!/usr/bin/env node
// One-shot validation of the wasm-elaboration-timeout hypothesis from
// NOTES.md. Stages the existing CDN bundle into the wasm install-prefix,
// patches a single failing Mathlib module with raised heartbeat +
// maxSynthPendingDepth, then invokes trace_fs.js. Cleans up afterward.
//
// Usage: node scripts/retry-heartbeat-experiment.js [module]
//   default module: Mathlib.LinearAlgebra.Dual.Lemmas

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, 'cdn/projects/mathlib-v4.27.0-2026-04/build');
const WASM_LEAN_ROOT = path.join(ROOT, 'vendor/lean-linux_wasm32');
const STDLIB_DIR = path.join(WASM_LEAN_ROOT, 'lib/lean');
const MATHLIB_SRC = path.join(ROOT, '.build-cache/mathlib-v4.27.0-2026-04/mathlib');
const TRACE_FS = path.join(ROOT, 'preflight/trace_fs.js');

const MODULE = process.argv[2] || 'Mathlib.LinearAlgebra.Dual.Lemmas';
const MAX_HEARTBEATS = process.env.MAX_HEARTBEATS || '800000';
const MAX_SYNTH = process.env.MAX_SYNTH_PENDING_DEPTH || '8';
// synthInstance.maxHeartbeats is a SEPARATE budget from maxHeartbeats
// (default 20000); wasm's slower typeclass search blows it on searches
// that fail-fast natively (seen: NumberTheory.ModularForms.NormTrace).
const MAX_SYNTH_HEARTBEATS = process.env.SYNTH_MAX_HEARTBEATS || '80000';

for (const p of [BUNDLE, WASM_LEAN_ROOT, MATHLIB_SRC, TRACE_FS]) {
  if (!fs.existsSync(p)) { console.error(`missing: ${p}`); process.exit(2); }
}

console.log(`[retry] module = ${MODULE}`);
console.log(`[retry] maxHeartbeats = ${MAX_HEARTBEATS}, maxSynthPendingDepth = ${MAX_SYNTH}`);

// --- Step 1: stage bundle into install-prefix via hardlinks --------------
console.log('[retry] staging bundle into install-prefix via hardlinks...');
const staged = []; // paths in STDLIB_DIR we created
const createdDirs = []; // dirs in STDLIB_DIR we created
let staged_count = 0, skipped_count = 0;

function walk(rel) {
  const srcDir = path.join(BUNDLE, rel);
  const ents = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const e of ents) {
    const sub = rel ? path.join(rel, e.name) : e.name;
    const src = path.join(BUNDLE, sub);
    const dst = path.join(STDLIB_DIR, sub);
    if (e.isDirectory()) {
      let createdNow = false;
      if (!fs.existsSync(dst)) {
        fs.mkdirSync(dst, { recursive: false });
        createdNow = true;
        createdDirs.push(dst);
      }
      walk(sub);
      if (createdNow) {
        // mark for possible removal if empty later
      }
    } else if (e.isFile()) {
      if (fs.existsSync(dst)) { skipped_count++; continue; }
      try {
        fs.linkSync(src, dst);
        staged.push(dst);
        staged_count++;
      } catch (err) {
        console.warn(`[retry] link failed ${dst}: ${err.message}`);
      }
    }
  }
}
walk('');
console.log(`[retry] staged ${staged_count} files (${skipped_count} already present), ${createdDirs.length} new dirs`);

// --- Step 2: patch the source file ----------------------------------------
const relSrc = MODULE.split('.').join('/') + '.lean';
const srcFile = path.join(MATHLIB_SRC, relSrc);
if (!fs.existsSync(srcFile)) { console.error(`source missing: ${srcFile}`); cleanup(); process.exit(3); }

const origSrc = fs.readFileSync(srcFile, 'utf8');
const setOptionBlock =
  `\n-- HEARTBEAT_EXPERIMENT\n` +
  `set_option maxHeartbeats ${MAX_HEARTBEATS}\n` +
  `set_option maxSynthPendingDepth ${MAX_SYNTH}\n` +
  `set_option synthInstance.maxHeartbeats ${MAX_SYNTH_HEARTBEATS}\n`;

// Insert set_options AFTER the import block. Lean 4.27 syntax uses
// `public import` / `import` lines plus an optional `module` keyword;
// all imports must come before anything else.
let patchedSrc;
const alreadyPatched = origSrc.includes('-- HEARTBEAT_EXPERIMENT');
if (alreadyPatched) {
  patchedSrc = origSrc;
} else {
  const lines = origSrc.split('\n');
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(public\s+import|import)\s+/.test(lines[i])) lastImportIdx = i;
  }
  if (lastImportIdx < 0) {
    console.error(`[retry] no import lines found in ${srcFile} — bailing`);
    cleanup();
    process.exit(3);
  }
  const head = lines.slice(0, lastImportIdx + 1).join('\n');
  const tail = lines.slice(lastImportIdx + 1).join('\n');
  patchedSrc = head + setOptionBlock + tail;
  fs.writeFileSync(srcFile, patchedSrc);
}
console.log(`[retry] patched ${srcFile} (alreadyPatched=${alreadyPatched})`);

// --- Step 3: invoke trace_fs.js -------------------------------------------
const modBase = MODULE.split('.').join('/');
const stageBase = path.join(STDLIB_DIR, modBase);
const oleanOut = stageBase + '.olean';
const ileanOut = stageBase + '.ilean';
fs.mkdirSync(path.dirname(stageBase), { recursive: true });

// Pre-remove any prior partial outputs so result is clean.
for (const ext of ['.olean', '.olean.private', '.olean.server', '.ir', '.ilean']) {
  try { fs.unlinkSync(stageBase + ext); } catch (_) {}
}

const env = {
  ...process.env,
  LEAN_INSTALL_DIR: WASM_LEAN_ROOT,
  LEAN_PATH: STDLIB_DIR,
  LEAN_EXTRA_MOUNTS: [BUNDLE, MATHLIB_SRC, STDLIB_DIR].join(':'),
};

const args = [
  '--stack-size=8192', '--max-old-space-size=10240',
  TRACE_FS,
  '-M', '8192',
  '-s', '8192',
  '-o', oleanOut, '-i', ileanOut,
  '-R', MATHLIB_SRC,
  srcFile,
];

console.log(`[retry] spawning trace_fs.js ...`);
const t0 = Date.now();
const child = spawn('node', args, { cwd: MATHLIB_SRC, env, stdio: 'inherit' });

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  console.log('[retry] cleanup...');

  // Restore source
  if (!alreadyPatched && fs.existsSync(srcFile)) {
    try { fs.writeFileSync(srcFile, origSrc); console.log(`[retry] restored ${srcFile}`); } catch (e) { console.error(`[retry] failed to restore source: ${e.message}`); }
  }

  // Move the produced olean (if any) to OUT_DIR and keep it
  let savedOutputs = 0;
  for (const ext of ['.olean', '.olean.private', '.olean.server', '.ir', '.ilean']) {
    const f = stageBase + ext;
    if (fs.existsSync(f)) {
      const dest = path.join(BUNDLE, modBase + ext);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f, dest);
        savedOutputs++;
      } catch (e) {
        console.error(`[retry] failed to save ${ext}: ${e.message}`);
      }
    }
  }
  if (savedOutputs) console.log(`[retry] saved ${savedOutputs} output artifacts to ${BUNDLE}`);

  // Remove staged hardlinks
  let removed = 0;
  for (const f of staged) {
    try { fs.unlinkSync(f); removed++; } catch (_) {}
  }
  // Remove dirs we created (in reverse order so leaves come first)
  let removedDirs = 0;
  for (const d of createdDirs.slice().reverse()) {
    try { fs.rmdirSync(d); removedDirs++; } catch (_) {} // skip if non-empty
  }
  console.log(`[retry] removed ${removed} staged files and ${removedDirs} created dirs`);
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

child.on('exit', (code) => {
  const ms = Date.now() - t0;
  console.log(`[retry] trace_fs.js exited code=${code} elapsed=${ms}ms`);
  cleanup();
  if (code === 0) {
    console.log(`[retry] ✓ ${MODULE} compiled cleanly with raised budgets`);
    console.log(`[retry] hypothesis CONFIRMED: heartbeat budget was the bottleneck`);
  } else {
    console.log(`[retry] ✗ ${MODULE} still failed (code=${code})`);
    console.log(`[retry] hypothesis NOT confirmed by this run; inspect stderr above`);
  }
  process.exit(code ?? 1);
});
