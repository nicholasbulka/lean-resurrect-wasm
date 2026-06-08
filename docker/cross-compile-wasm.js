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
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const required = ['PEGS_FILE', 'LIBRARY_KEY', 'SCRATCH', 'PREFLIGHT', 'WASM_LEAN_ROOT', 'OUT_DIR'];
for (const k of required) {
  if (!process.env[k]) { console.error('[cross-compile] missing env:', k); process.exit(2); }
}
// realpath everything so symlinks (notably macOS /tmp -> /private/tmp)
// don't desync host paths from MEMFS mount points. Lean WASM writes to
// the literal path string we pass it; the NODEFS mount uses realpath.
const PEGS_FILE      = fs.realpathSync(process.env.PEGS_FILE);
const LIBRARY_KEY    = process.env.LIBRARY_KEY;
const SCRATCH        = fs.realpathSync(process.env.SCRATCH);
const PREFLIGHT      = fs.realpathSync(process.env.PREFLIGHT);
const WASM_LEAN_ROOT = fs.realpathSync(process.env.WASM_LEAN_ROOT);
// OUT_DIR is the only one we create on demand.
fs.mkdirSync(process.env.OUT_DIR, { recursive: true });
const OUT_DIR        = fs.realpathSync(process.env.OUT_DIR);
const ABORT_ON_FAIL  = process.env.ABORT_ON_FAIL === '1';
// CONCURRENCY: max simultaneous lean-process compiles. Each lean instance
// can use 1-5 GB at peak, so the practical cap is RAM/8GB on most machines.
// Default 1 (strict sequential) — set CONCURRENCY=N to parallelize.
// Files are still scheduled in topological dep order: a module only runs
// once its in-package imports have finished.
const CONCURRENCY    = Math.max(1, parseInt(process.env.CONCURRENCY || '1', 10) || 1);

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
    if (fs.statSync(pkgRoot).isDirectory() && anyLeanUnder(pkgRoot)) {
      // Resolve to realpath so the path Lean sees matches what
      // trace_fs.js's NODEFS mount accepts (symlinks at this level
      // would mount the realpath but leave Lean addressing the
      // symlinked path → "no such file or directory" inside MEMFS).
      // See the wrapped-Mathlib setup: SCRATCH/mathlib -> <wrapped>/.
      return fs.realpathSync(pkgRoot);
    }
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

// Walk a srcRoot for .lean files. Two modes:
//   - compileRoot specified: only include <compileRoot>.lean and files
//     under <compileRoot>/. This is correct for lake-style packages
//     where module names are <PkgNamespace>.<...> and any other top-
//     level dir (BatteriesTest/, Shake/, scripts/, examples/) is not
//     part of the library and likely won't compile in our setup.
//   - compileRoot null: walk everything, skipping a hard-coded list
//     of conventional non-library dirs. Used when the package has no
//     clear single namespace root.
const SKIP_DIRS_GLOBAL = new Set([
  'test', 'tests', 'Test', 'Tests',
  'example', 'examples', 'Example', 'Examples',
  'Archive', 'archive',
  'scripts', 'Scripts',
  'Counterexamples',
  'DownstreamTest',
  'LongestPole',
  'Cache',
]);
function listLeanFiles(srcRoot, compileRoot) {
  // Note: dirent.isDirectory() returns FALSE for symlinks-to-directories.
  // Some package layouts (e.g. our wrapped Mathlib checkout: Mathlib/ is
  // a symlink to ~/mathlib4-ref/<rev>/) need us to follow them. Use
  // fs.statSync (which follows symlinks) for any non-dir non-file entry.
  function isWalkableDir(full, e) {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try { return fs.statSync(full).isDirectory(); } catch (_) { return false; }
  }

  const out = [];
  if (compileRoot) {
    const rootDir = path.join(srcRoot, compileRoot);
    const rootFile = path.join(srcRoot, compileRoot + '.lean');
    if (fs.existsSync(rootFile)) out.push(compileRoot + '.lean');
    if (fs.existsSync(rootDir)) {
      function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          const r = rel ? path.join(rel, e.name) : e.name;
          if (isWalkableDir(full, e)) walk(full, r);
          else if (e.name.endsWith('.lean')) out.push(r);
        }
      }
      walk(rootDir, compileRoot);
    }
  } else {
    function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (isWalkableDir(path.join(dir, e.name), e) && SKIP_DIRS_GLOBAL.has(e.name)) continue;
        const full = path.join(dir, e.name);
        const r = rel ? path.join(rel, e.name) : e.name;
        if (isWalkableDir(full, e)) walk(full, r);
        else if (e.name.endsWith('.lean')) out.push(r);
      }
    }
    walk(srcRoot, '');
  }
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
// Lean 4 module-system import lines look like:
//   import Foo.Bar
//   public import Foo.Bar
//   meta import Foo.Bar
//   public meta import Foo.Bar
//   private meta import Foo.Bar
//   @[deprecated] import Foo.Bar
// Modifiers can appear in any combination / order before the `import` keyword.
const IMPORT_RE = /^\s*(?:public\s+|private\s+|meta\s+|@\[[^\]]*\]\s*)*import\s+(.+?)\s*(?:--.*)?$/;
// Match an `import ...` example sitting INSIDE a docstring's markdown code
// fence ("```\nimport ...\n```"); we mustn't treat those as real imports.
// Also block comments `/- ... -/` (which Lean nests). Track both states
// across lines so a usage example inside a `/-! ... -/` doc-comment
// containing ```...``` doesn't appear to add fictitious deps.
function parseImports(source) {
  const out = [];
  let blockCommentDepth = 0;
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    // Heuristic comment / fence tracking — character-perfect Lean lexing
    // would be ideal, but for the import-extraction use case this is
    // robust against the actual cases that bit us:
    //   - /-... -/ block comments
    //   - /-! ... -/ doc comments containing ```import ...``` blocks
    const trimmed = line.trim();

    // Toggle markdown code fence on lines starting with ``` (Lean docstrings
    // use this for usage examples; the `import` lines inside aren't real).
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;

    // Block-comment open / close. We don't try to handle them mid-line —
    // these always sit on their own line in practice for top-level
    // doc/banner comments, which is what causes false positives.
    if (/^\/-/.test(trimmed) && !/-\/\s*$/.test(trimmed)) { blockCommentDepth++; continue; }
    if (blockCommentDepth > 0) {
      if (/-\/\s*$/.test(trimmed)) blockCommentDepth--;
      continue;
    }

    if (!trimmed || trimmed.startsWith('--')) continue;
    const m = IMPORT_RE.exec(line);
    if (!m) continue;
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

// Lean's v4.27 wasm32 build doesn't reliably honor LEAN_PATH from
// Module.ENV under PROXY_TO_PTHREAD (documented at preflight/trace_fs.js).
// Workaround: write each compiled olean directly INTO the install-prefix
// stdlib dir (the one path Lean's init_search_path always reads). Remember
// what we add so we can harvest the project-specific files into the bundle
// after the build finishes — and so we can clean up on abnormal exit.
const STDLIB_DIR = path.join(WASM_LEAN_ROOT, 'lib', 'lean');
const stagedFiles = new Set();
process.on('exit', () => {
  // Best-effort cleanup so an interrupted build doesn't leave artifacts
  // mixed into the install-prefix. Final harvest copies them out before
  // exit, so this only fires for files still present (i.e. on failure).
  for (const f of stagedFiles) { try { fs.unlinkSync(f); } catch (_) {} }
});

// Pre-stage everything that's already in OUT_DIR into install-prefix.
// For builds that depend on previously-built libraries (e.g. mathlib-only
// depends on batteries+aesop+...), the deps' oleans are unpacked into
// OUT_DIR before the script runs. Without this pre-stage, the resume
// logic only copies modules WITHIN the current package's deps[] — so
// batteries' oleans, while present in OUT_DIR, never reach install-
// prefix where Lean searches. Walking OUT_DIR once at startup is cheap
// (filesystem-bound, no compile work).
function preStageOutDirIntoInstallPrefix() {
  function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (/\.(olean(\.private|\.server)?|ilean|ir)$/.test(e.name)) {
        const dest = path.join(STDLIB_DIR, r);
        if (fs.existsSync(dest)) continue; // don't clobber stdlib's own files
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        stagedFiles.add(dest);
      }
    }
  }
  try { walk(OUT_DIR, ''); } catch (_) {}
}
preStageOutDirIntoInstallPrefix();
console.log(`[cross-compile] pre-staged ${stagedFiles.size} dep files into install-prefix`);

(async function main() {
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
  // outLib for the BUNDLE is OUT_DIR itself — we want a flat module
  // namespace there (Cli.olean, Cli/Basic.olean, etc), so when the IDE
  // stages the bundle at /work/lib/lean/* the file paths line up with
  // module names. Compile-time staging into STDLIB_DIR is what makes
  // imports resolve while we build.
  const outLib = OUT_DIR;
  fs.mkdirSync(outLib, { recursive: true });

  // compileRoot defaults to the package name with an uppercased first
  // letter (lake convention: package "batteries" -> namespace "Batteries").
  // Override per-dep in the pegs file via { compileRoot: "Foo" } to support
  // exceptions (e.g. lean4-cli's package "Cli" matches its namespace
  // exactly with no case change).
  const compileRoot = pkg.compileRoot ||
    (pkgName === pkgName.toLowerCase()
      ? pkgName.charAt(0).toUpperCase() + pkgName.slice(1)
      : pkgName);
  const leanFiles = listLeanFiles(srcRoot, compileRoot);
  console.log(`[${pkgName}] compileRoot=${compileRoot} ${leanFiles.length} .lean files under ${srcRoot}`);

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

  // LEAN_PATH set to the install-prefix stdlib dir (which is where we
  // also stage compiled outputs). PROXY_TO_PTHREAD doesn't reliably
  // honor LEAN_PATH overrides, so this is mostly belt-and-suspenders —
  // the actual search uses the build's baked-in install-prefix.
  const leanPathStr = STDLIB_DIR;

  const pkgResult = { name: pkgName, srcRoot, fileCount: leanFiles.length, ok: 0, fail: 0, durations: {} };

  // Compile a single module. Returns a promise resolving with status.
  // Spawns lean async (no spawnSync) so multiple compiles can run.
  function compileOne(mod) {
    return new Promise((resolve) => {
      const relPath = mod.split('.').join('/') + '.lean';
      const srcFile = path.join(srcRoot, relPath);
      const modBase = mod.split('.').join('/');
      const stageBase = path.join(STDLIB_DIR, modBase);
      const oleanOut = stageBase + '.olean';
      const ileanOut = stageBase + '.ilean';

      // Resume: if outLib already has this module's .olean from a prior
      // run, copy it back into install-prefix (so dependents can find it
      // when their own compile runs) and skip the lean invocation.
      const outBase = path.join(outLib, modBase);
      if (fs.existsSync(outBase + '.olean')) {
        fs.mkdirSync(path.dirname(stageBase), { recursive: true });
        for (const ext of ['.olean', '.olean.private', '.olean.server', '.ir', '.ilean']) {
          const out = outBase + ext;
          const stage = stageBase + ext;
          if (fs.existsSync(out) && !fs.existsSync(stage)) {
            fs.copyFileSync(out, stage);
            stagedFiles.add(stage);
          }
        }
        resolve({ ok: true, status: 0, ms: 0, stdout: '', stderr: '', mod, modBase, stageBase, resumed: true });
        return;
      }

      fs.mkdirSync(path.dirname(stageBase), { recursive: true });

      const extraMounts = [OUT_DIR, ...cumulativeLeanPathDirs].filter(Boolean).join(':');
      const t0 = Date.now();
      // wasm32's slower elaborator runtime stretches normal proof
      // elaboration past Lean's default 200K heartbeat budget, causing
      // tactics like simp_rw to abort mid-flight and leave partial goal
      // state that the next tactic blames. Bump globally; cheap for fast
      // modules. See NOTES.md / feedback_wasm_elaboration_heartbeats.
      const maxHeartbeats = process.env.LEAN_MAX_HEARTBEATS || '800000';
      const maxSynthPendingDepth = process.env.LEAN_MAX_SYNTH_PENDING_DEPTH || '8';
      // synthInstance.maxHeartbeats is a separate budget (default 20000).
      // wasm's slower typeclass search can blow it on instance searches
      // that fail-fast natively, turning an expected synth failure into a
      // hard (deterministic) timeout error. Seen on
      // Mathlib.NumberTheory.ModularForms.NormTrace. Scale 4× like
      // maxHeartbeats.
      const maxSynthHeartbeats = process.env.LEAN_SYNTH_MAX_HEARTBEATS || '80000';
      const child = spawn(
        'node',
        ['--stack-size=8192', '--max-old-space-size=10240',
         path.join(PREFLIGHT, 'trace_fs.js'),
         '-M', '8192',
         '-s', '8192',
         '-D', `maxHeartbeats=${maxHeartbeats}`,
         '-D', `maxSynthPendingDepth=${maxSynthPendingDepth}`,
         '-D', `synthInstance.maxHeartbeats=${maxSynthHeartbeats}`,
         '-o', oleanOut, '-i', ileanOut, '-R', srcRoot, srcFile],
        {
          cwd: srcRoot,
          env: {
            ...process.env,
            LEAN_INSTALL_DIR: WASM_LEAN_ROOT,
            LEAN_PATH: leanPathStr,
            LEAN_EXTRA_MOUNTS: extraMounts,
          },
        }
      );
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => resolve({ ok: false, status: -1, ms: Date.now() - t0, stdout, stderr: stderr + '\n' + e.message, mod, modBase, stageBase }));
      child.on('close', (code) => resolve({ ok: code === 0, status: code, ms: Date.now() - t0, stdout, stderr, mod, modBase, stageBase }));
    });
  }

  function recordResult(r) {
    pkgResult.durations[r.mod] = r.ms;
    if (r.ok) {
      pkgResult.ok++;
      results.totals.compiledOk++;
      for (const ext of ['.olean', '.olean.private', '.olean.server', '.ir', '.ilean']) {
        const f = r.stageBase + ext;
        if (fs.existsSync(f)) {
          stagedFiles.add(f);
          const dest = path.join(outLib, r.modBase + ext);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(f, dest);
        }
      }
      console.log(`[${pkgName}] ${r.resumed ? '↻' : '✓'} ${r.mod} (${r.ms}ms)`);
    } else {
      pkgResult.fail++;
      results.totals.compiledFail++;
      console.error(`[${pkgName}] ✗ ${r.mod} (${r.ms}ms) status=${r.status}`);
      const so = (r.stdout || '').slice(0, 1000);
      const se = (r.stderr || '').slice(0, 1000);
      if (so) console.error('  stdout:', so);
      if (se) console.error('  stderr:', se);
    }
  }

  // Topo-aware worker pool. Maintain a ready queue of modules with all
  // in-package deps satisfied; up to CONCURRENCY workers pull from it.
  // When a module completes, its dependents whose remaining-deps drop to
  // zero get added to the ready queue.
  if (CONCURRENCY === 1) {
    // Strict sequential — preserves existing behavior bit-for-bit.
    for (const mod of modOrder) {
      if (ABORT_ON_FAIL && results.totals.compiledFail > 0) break;
      const r = await compileOne(mod);
      recordResult(r);
      if (!r.ok && ABORT_ON_FAIL) { results.packages.push(pkgResult); writeReport(); process.exit(5); }
    }
  } else {
    console.log(`[${pkgName}] CONCURRENCY=${CONCURRENCY}`);
    const remaining = new Map(); // mod -> Set<unfinished dep>
    const dependents = new Map(); // mod -> Set<dependent>
    for (const [mod, deps] of graph.entries()) {
      remaining.set(mod, new Set(deps));
      for (const d of deps) {
        if (!dependents.has(d)) dependents.set(d, new Set());
        dependents.get(d).add(mod);
      }
    }
    const ready = [];
    for (const [mod, deps] of remaining.entries()) if (deps.size === 0) ready.push(mod);
    let inFlight = 0;
    let totalDone = 0;
    const totalCount = remaining.size;
    let aborted = false;
    await new Promise((finishPkg) => {
      function pump() {
        if (totalCount === 0) { finishPkg(); return; }
        if (aborted && inFlight === 0) { finishPkg(); return; }
        while (!aborted && inFlight < CONCURRENCY && ready.length > 0) {
          const mod = ready.shift();
          inFlight++;
          compileOne(mod).then((r) => {
            recordResult(r);
            inFlight--;
            totalDone++;
            if (!r.ok && ABORT_ON_FAIL) { aborted = true; pump(); return; }
            // Mark mod's dependents as one-step-closer-to-ready.
            for (const dep of (dependents.get(mod) ?? [])) {
              const remDeps = remaining.get(dep);
              remDeps.delete(mod);
              if (remDeps.size === 0) ready.push(dep);
            }
            if (totalDone === totalCount) finishPkg();
            else pump();
          });
        }
        if (!aborted && inFlight === 0 && totalDone < totalCount && ready.length === 0) {
          // Stuck — likely a cycle the topo sort broke arbitrarily; nothing
          // ready, nothing in flight, more to do. Bail with diagnostic.
          console.error(`[${pkgName}] scheduler stuck: ${totalDone}/${totalCount} done, none ready`);
          for (const [mod, deps] of remaining.entries()) {
            if (deps.size > 0) console.error(`  ${mod} still waits on: ${[...deps].join(', ')}`);
          }
          aborted = true;
          finishPkg();
        }
      }
      pump();
    });
    if (aborted && ABORT_ON_FAIL && results.totals.compiledFail > 0) {
      results.packages.push(pkgResult); writeReport(); process.exit(5);
    }
  }

  cumulativeLeanPathDirs.push(outLib);
  results.packages.push(pkgResult);
}

// Harvest done by per-file copy above. Remove staged files from STDLIB_DIR
// so the install-prefix is left as we found it. (process.on('exit') also
// fires for partial cleanup if the script aborts mid-build.)
console.log(`[cross-compile] removing ${stagedFiles.size} files from install-prefix`);
for (const f of stagedFiles) { try { fs.unlinkSync(f); } catch (_) {} }
stagedFiles.clear();

function writeReport() {
  fs.writeFileSync(path.join(OUT_DIR, 'cross-compile-report.json'), JSON.stringify(results, null, 2));
}
writeReport();
console.log('[cross-compile] totals:', JSON.stringify(results.totals));
process.exit(results.totals.compiledFail > 0 ? 6 : 0);
})().catch((e) => { console.error('[cross-compile] fatal:', e); process.exit(7); });
