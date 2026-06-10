#!/usr/bin/env node
// Build the "core base-layer bundle" for a Mathlib CDN project: the common
// prelude that nearly every Mathlib file imports.
//
// Core = transitive-import closure of Mathlib.Init over the import graph
// (Mathlib.Init is imported pervasively — it pulls the whole linter suite —
// so its closure is the standard base that almost every file needs). The
// browser loader stages this bundle once, then fetches only per-file deltas
// (closure(file) - core) on top.
//
// Outputs (under cdn/projects/<slug>/):
//   core-modules.json          tiny record: { format, coreRoot, moduleCount, modules:[...] }
//   core.bundle.NNN            sharded standalone bundles (each a valid bundle)
//   core.bundle.manifest.json  shard list + per-shard sha256 + counts + totals
//
// The bundle is produced by reusing docker/pack-bundle.js verbatim: we stage
// hardlinks of just the core modules' olean files into a temp dir that mirrors
// the build tree, run pack-bundle.js --shard-bytes on it, then clean up. This
// keeps the wire format byte-identical to the full bundle.
//
// Usage:
//   node build-core-bundle.js [<slug>]
//     slug   project slug under cdn/projects/  (default: mathlib-v4.27.0-2026-04)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SLUG = process.argv[2] || 'mathlib-v4.27.0-2026-04';
const CORE_ROOT = 'Mathlib.Init';
const SHARD_BYTES = 500000000;

const projectDir = path.join(REPO_ROOT, 'cdn', 'projects', SLUG);
const graphFile = path.join(projectDir, 'import-graph.json');
const buildDir = path.join(projectDir, 'build');
const coreModulesFile = path.join(projectDir, 'core-modules.json');
const bundleOut = path.join(projectDir, 'core.bundle');
const packBundle = path.join(REPO_ROOT, 'docker', 'pack-bundle.js');

for (const [label, p] of [['import-graph.json', graphFile], ['build dir', buildDir], ['pack-bundle.js', packBundle]]) {
  if (!fs.existsSync(p)) { console.error(`[core-bundle] missing ${label}: ${p}`); process.exit(2); }
}

// --- 1. Load graph --------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const graph = manifest.graph;
if (!graph || !(CORE_ROOT in graph)) {
  console.error(`[core-bundle] graph has no node "${CORE_ROOT}"`); process.exit(2);
}

// --- 2. Transitive closure of CORE_ROOT (BFS, includes the root) ----------
const core = new Set();
const queue = [CORE_ROOT];
while (queue.length) {
  const mod = queue.pop();
  if (core.has(mod)) continue;
  core.add(mod);
  for (const dep of (graph[mod] || [])) if (!core.has(dep)) queue.push(dep);
}
const coreSorted = Array.from(core).sort();

// --- 3. Write core-modules.json -------------------------------------------
fs.writeFileSync(coreModulesFile, JSON.stringify({
  format: 'core-set/1',
  coreRoot: CORE_ROOT,
  moduleCount: coreSorted.length,
  modules: coreSorted,
}, null, 2));
console.log(`[core-bundle] core = ${coreSorted.length} modules (closure of ${CORE_ROOT}) -> ${coreModulesFile}`);

// --- 4. Stage hardlinks of core modules' files into a temp build tree -----
// pack-bundle.js walks a directory and keeps .olean/.olean.private/
// .olean.server/.ilean/.ir. We mirror just the core subset so the bundle is a
// strict slice of the full one, then reuse pack-bundle.js for the wire format.
const EXTS = ['.olean', '.olean.private', '.olean.server', '.ilean', '.ir'];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-bundle-'));
let staged = 0, missing = 0;
try {
  for (const mod of coreSorted) {
    const relBase = mod.split('.').join(path.sep); // Mathlib/Init
    let any = false;
    for (const ext of EXTS) {
      const src = path.join(buildDir, relBase + ext);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(tmpDir, relBase + ext);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      try { fs.linkSync(src, dst); } catch (_) { fs.copyFileSync(src, dst); }
      staged++; any = true;
    }
    if (!any) missing++;
  }
  if (missing) console.warn(`[core-bundle] WARNING: ${missing} core modules had no olean files on disk`);
  console.log(`[core-bundle] staged ${staged} files into temp tree`);

  // --- 5. Pack via existing pack-bundle.js (sharded) ----------------------
  execFileSync('node', [packBundle, tmpDir, bundleOut, '--shard-bytes', String(SHARD_BYTES)], {
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- 6. Summary -----------------------------------------------------------
const bundleManifest = JSON.parse(fs.readFileSync(`${bundleOut}.manifest.json`, 'utf8'));
const totalBytes = bundleManifest.totalBundleBytes;
console.log(`[core-bundle] DONE: ${coreSorted.length} core modules, ${bundleManifest.shards.length} shards, ${totalBytes} bytes (${(totalBytes / 1e6).toFixed(1)} MB)`);
