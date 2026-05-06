#!/usr/bin/env node
// Cross-compile a set of cloned Lean packages to wasm32 oleans.
//
// Strategy: bypass lake entirely. For each package, scan its .lean files,
// parse import statements to derive a per-package dependency graph, and
// invoke the wasm32 lean (via preflight/trace_fs.js) once per file in
// topological order. Output oleans land in OUT_DIR/<pkg>/lib/<Module>.olean.
// LEAN_PATH for each compile lists every pkg's lib dir already built, so
// cross-package imports resolve.
//
// This is the "manual" CROSS_COMPILE_PATH. Slower than lake but predictable
// and host-arch-independent.
//
// Inputs (env, set by the container entry script):
//   PEGS_FILE      e.g. /config/wasm-deps.json
//   LIBRARY_KEY    key under .libraries
//   SCRATCH        clone tree (one subdir per dep)
//   PREFLIGHT      contains trace_fs.js
//   WASM_LEAN_ROOT path to vendored wasm32 lean (LEAN_INSTALL_DIR for harness)
//   OUT_DIR        where to write build outputs (<pkg>/lib/<Module>.olean)
//   ABORT_ON_FAIL  default 0; if 1, stop at first compile failure instead
//                  of recording it and continuing

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const required = ['PEGS_FILE', 'LIBRARY_KEY', 'SCRATCH', 'PREFLIGHT', 'WASM_LEAN_ROOT', 'OUT_DIR'];
for (const k of required) {
  if (!process.env[k]) { console.error('[cross-compile] missing env:', k); process.exit(2); }
}
const PEGS_FILE      = process.env.PEGS_FILE;
const LIBRARY_KEY    = process.env.LIBRARY_KEY;
const SCRATCH        = process.env.SCRATCH;
const PREFLIGHT      = process.env.PREFLIGHT;
const WASM_LEAN_ROOT = process.env.WASM_LEAN_ROOT;
const OUT_DIR        = process.env.OUT_DIR;
const ABORT_ON_FAIL  = process.env.ABORT_ON_FAIL === '1';

const pegs = JSON.parse(fs.readFileSync(PEGS_FILE, 'utf8'));
const lib = pegs.libraries[LIBRARY_KEY];
if (!lib) { console.error('[cross-compile] no library:', LIBRARY_KEY); process.exit(2); }

fs.mkdirSync(OUT_DIR, { recursive: true });

// Per-package source root. Lake projects almost always use the repo
// root as srcDir, with a top-level <Namespace>.lean entry file plus a
// <Namespace>/ tree. Module names are derived from path-from-srcRoot,
// so srcRoot = repo root produces the right names. We DON'T try the
// nested <repo>/<pkgName>/ as srcRoot — that would strip the namespace
// prefix and produce unqualified module names that import paths can't
// resolve.
function findPackageSrcRoot(pkgName, pkgRoot) {
  try {
    if (fs.statSync(pkgRoot).isDirectory() && anyLeanUnder(pkgRoot)) return pkgRoot;
  } catch (_) {}
  return null;
}
function anyLeanUnder(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (anyLeanUnder(path.join(dir, e.name))) return true;
      } else if (e.name.endsWith('.lean')) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

// Walk a srcRoot recursively, return list of .lean files (relative to srcRoot).
// Skips dirs that conventionally hold non-library source: tests, examples,
// archive material, scripts, etc. Conservative — false positives only
// produce harmless extra modules.
const SKIP_DIRS = new Set([
  'test', 'tests', 'Test', 'Tests',
  'example', 'examples', 'Example', 'Examples',
  'Archive', 'archive',
  'scripts', 'Scripts',
  'Counterexamples',
  'DownstreamTest',
  'LongestPole',
  'Cache',
]);
function listLeanFiles(srcRoot) {
  const out = [];
  function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.name.endsWith('.lean')) out.push(r);
    }
  }
  walk(srcRoot, '');
  return out.sort();
}

// Module name derived from path-under-srcRoot. e.g. "Foo/Bar.lean" -> "Foo.Bar".
function moduleNameFromRelPath(rel) {
  const noExt = rel.endsWith('.lean') ? rel.slice(0, -5) : rel;
  return noExt.split(path.sep).join('.');
}

// Lean module imports parser. Lean 4 imports look like:
//   import Foo.Bar
//   import Foo.Bar Foo.Baz  -- multiple
//   public import Foo.Bar
//   private import Foo.Bar
// Plus comments and `module` line. This is conservative — anything not
// matching a simple import on its own line is ignored.
const IMPORT_RE = /^\s*(?:public\s+|private\s+|@\[[^\]]*\]\s*)*import\s+(.+?)\s*(?:--.*)?$/;
function parseImports(source) {
  const out = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    const m = IMPORT_RE.exec(line);
    if (!m) continue;
    // Multiple imports on one line, space-separated.
    for (const tok of m[1].split(/\s+/)) {
      if (tok && /^[A-Za-z_][A-Za-z0-9_'.]*$/.test(tok)) out.push(tok);
    }
  }
  return out;
}

// Topological sort given a Map<node, deps[]>. Returns ordered array.
// On cycles, breaks them and reports.
function topoSort(graph) {
  const order = [];
  const visited = new Map(); // node -> 'visiting' | 'done'
  const cycles = [];
  function visit(n, stack) {
    const s = visited.get(n);
    if (s === 'done') return;
    if (s === 'visiting') {
      cycles.push([...stack, n]);
      return;
    }
    visited.set(n, 'visiting');
    for (const d of graph.get(n) ?? []) visit(d, [...stack, n]);
    visited.set(n, 'done');
    order.push(n);
  }
  for (const n of graph.keys()) visit(n, []);
  return { order, cycles };
}

// Determine package build order. Uses the order from `deps` in the pegs
// file — assumed to be topologically valid (the operator who maintains
// the pegs orders dependencies first). This is a known gap; a better
// implementation would inspect each lakefile to derive the real order.
const packagesToBuild = lib.deps.filter((d) => !d.url.startsWith('local://'));

const results = {
  libraryKey: LIBRARY_KEY,
  packages: [],
  totals: { compiledOk: 0, compiledFail: 0, skipped: 0 },
};

// Cumulative LEAN_PATH: every already-built pkg's lib dir.
const cumulativeLeanPathDirs = [];

for (const pkg of packagesToBuild) {
  const pkgName = pkg.name;
  const pkgRoot = path.join(SCRATCH, pkgName);
  const srcRoot = findPackageSrcRoot(pkgName, pkgRoot);
  if (!srcRoot) {
    console.error(`[${pkgName}] no source root with .lean files found under ${pkgRoot}`);
    results.packages.push({ name: pkgName, skipped: 'no-source-root' });
    results.totals.skipped++;
    continue;
  }
  const outLib = path.join(OUT_DIR, pkgName, 'lib');
  fs.mkdirSync(outLib, { recursive: true });

  const leanFiles = listLeanFiles(srcRoot);
  console.log(`[${pkgName}] ${leanFiles.length} .lean files under ${srcRoot}`);

  // Build per-package dep graph from imports. Only include imports that
  // resolve to a module in this package's own .lean files; cross-package
  // imports are handled via LEAN_PATH (already-built oleans).
  const inPkgModules = new Set(leanFiles.map((f) => moduleNameFromRelPath(f)));
  const graph = new Map();
  for (const f of leanFiles) {
    const mod = moduleNameFromRelPath(f);
    const src = fs.readFileSync(path.join(srcRoot, f), 'utf8');
    const imports = parseImports(src).filter((m) => inPkgModules.has(m));
    graph.set(mod, imports);
  }
  const { order: modOrder, cycles } = topoSort(graph);
  if (cycles.length) {
    console.warn(`[${pkgName}] ${cycles.length} import cycles detected; broken arbitrarily`);
  }

  // Per-package LEAN_PATH = own outLib (so already-built modules in this
  // pkg are reachable) + all previously-built packages' outLibs.
  const leanPathStr = [outLib, ...cumulativeLeanPathDirs].join(':');

  const pkgResult = { name: pkgName, srcRoot, fileCount: leanFiles.length, ok: 0, fail: 0, durations: {} };
  for (const mod of modOrder) {
    const relPath = mod.split('.').join('/') + '.lean';
    const srcFile = path.join(srcRoot, relPath);
    const oleanOut = path.join(outLib, mod.split('.').join('/') + '.olean');
    const ileanOut = path.join(outLib, mod.split('.').join('/') + '.ilean');
    fs.mkdirSync(path.dirname(oleanOut), { recursive: true });

    const t0 = Date.now();
    // The harness mounts cwd into the WASM FS by default so input files
    // are reachable. Output files (the .olean we're producing) live
    // under OUT_DIR which may not be a child of cwd, so pass OUT_DIR
    // and every previously-built outLib via LEAN_EXTRA_MOUNTS — the
    // harness mounts them too.
    const extraMounts = [OUT_DIR, ...cumulativeLeanPathDirs].filter(Boolean).join(':');
    const proc = spawnSync(
      'node',
      ['--stack-size=8192', path.join(PREFLIGHT, 'trace_fs.js'),
       '-o', oleanOut, '-i', ileanOut, '-R', srcRoot, srcFile],
      {
        cwd: srcRoot,
        env: {
          ...process.env,
          LEAN_INSTALL_DIR: WASM_LEAN_ROOT,
          LEAN_PATH: leanPathStr,
          LEAN_EXTRA_MOUNTS: extraMounts,
        },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    const ms = Date.now() - t0;
    pkgResult.durations[mod] = ms;
    if (proc.status === 0) {
      pkgResult.ok++;
      results.totals.compiledOk++;
      console.log(`[${pkgName}] ✓ ${mod} (${ms}ms)`);
    } else {
      pkgResult.fail++;
      results.totals.compiledFail++;
      console.error(`[${pkgName}] ✗ ${mod} (${ms}ms) status=${proc.status}`);
      console.error('  stderr:', (proc.stderr || '').slice(0, 500));
      if (ABORT_ON_FAIL) { results.packages.push(pkgResult); writeReport(); process.exit(5); }
    }
  }
  cumulativeLeanPathDirs.push(outLib);
  results.packages.push(pkgResult);
}

function writeReport() {
  fs.writeFileSync(path.join(OUT_DIR, 'cross-compile-report.json'), JSON.stringify(results, null, 2));
}
writeReport();
console.log('[cross-compile] totals:', JSON.stringify(results.totals));
process.exit(results.totals.compiledFail > 0 ? 6 : 0);
