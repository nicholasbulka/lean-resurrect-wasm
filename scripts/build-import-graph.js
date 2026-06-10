#!/usr/bin/env node
// Build the per-module import-graph manifest for a cross-compiled bundle.
//
// The browser loader uses this to compute the transitive-import closure of a
// user's file and prefetch exactly those module oleans (instead of all ~4 GB)
// — the closure-prefetch half of the hybrid loader. See memory
// demand_paging_node_pthread_fs / project_dep_pegs.
//
// Edges are read from each module's source `import` lines (authoritative for
// direct deps; transitivity is just BFS over these). Only edges to modules
// that are actually SHIPPED in the bundle are kept — imports of stdlib
// (Init.*, Std.*, Lean.*) are pruned because stdlib is always staged at
// /lib/lean and never fetched from the CDN.
//
// Usage:
//   node build-import-graph.js <build-dir> <sources-root> <out.json>
//     build-dir     cdn/projects/<slug>/build   (the per-module olean tree)
//     sources-root  .build-cache/<slug>/         (holds each dep checkout)
//     out.json      where to write the manifest

const fs = require('node:fs');
const path = require('node:path');

const [, , buildDir, sourcesRoot, outFile] = process.argv;
if (!buildDir || !sourcesRoot || !outFile) {
  console.error('usage: build-import-graph.js <build-dir> <sources-root> <out.json>');
  process.exit(2);
}

// --- 1. Node set: every module shipped as an .olean in the bundle ----------
// module name uses Lean dotted form: Mathlib/Data/Nat/Notation -> Mathlib.Data.Nat.Notation
const shipped = new Set();
function walkOleans(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const sub = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkOleans(path.join(dir, e.name), sub);
    else if (e.name.endsWith('.olean') && !e.name.endsWith('.olean.private') && !e.name.endsWith('.olean.server')) {
      shipped.add(sub.slice(0, -'.olean'.length).split('/').join('.'));
    }
  }
}
walkOleans(buildDir, '');

// --- 2. Map each module's first path component -> source checkout root ------
// Each dep checkout under sourcesRoot holds a <Namespace>/ source tree. Index
// namespace -> checkout dir so a module name resolves to its .lean file.
const nsToCheckout = new Map();
for (const d of fs.readdirSync(sourcesRoot, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const checkout = path.join(sourcesRoot, d.name);
  let tops;
  try { tops = fs.readdirSync(checkout, { withFileTypes: true }); } catch (_) { continue; }
  for (const t of tops) {
    // A namespace root is a dir whose name starts uppercase and that holds
    // .lean files somewhere beneath it (or a sibling <Name>.lean).
    if (t.isDirectory() && /^[A-Z]/.test(t.name) && !nsToCheckout.has(t.name)) {
      nsToCheckout.set(t.name, checkout);
    }
  }
}

function sourceOf(moduleName) {
  const rel = moduleName.split('.').join('/') + '.lean';
  const ns = moduleName.split('.')[0];
  const checkout = nsToCheckout.get(ns);
  if (checkout) {
    const p = path.join(checkout, rel);
    if (fs.existsSync(p)) return p;
  }
  // Fallback: scan every checkout (handles casing/edge cases).
  for (const c of new Set(nsToCheckout.values())) {
    const p = path.join(c, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// --- 3. Parse direct imports per shipped module, prune to shipped edges -----
const IMPORT_RE = /^\s*(?:public\s+|private\s+|meta\s+)*import\s+(?:all\s+)?([A-Za-z0-9_.]+)/;
const graph = {};
let noSource = 0, edges = 0;
for (const mod of shipped) {
  const src = sourceOf(mod);
  if (!src) { graph[mod] = []; noSource++; continue; }
  const deps = [];
  const text = fs.readFileSync(src, 'utf8');
  for (const line of text.split('\n')) {
    if (/^\s*(?:\/-|--)/.test(line)) continue; // skip comment lines cheaply
    const m = IMPORT_RE.exec(line);
    if (m && shipped.has(m[1]) && m[1] !== mod) { deps.push(m[1]); edges++; }
  }
  graph[mod] = Array.from(new Set(deps)).sort();
}

const manifest = {
  format: 'import-graph/1',
  totalModules: shipped.size,
  shippedEdges: edges,
  modulesWithoutSource: noSource,
  graph,
};
fs.writeFileSync(outFile, JSON.stringify(manifest));
console.log(`[import-graph] ${shipped.size} modules, ${edges} shipped edges, ${noSource} without source -> ${outFile}`);
console.log(`[import-graph] manifest bytes: ${fs.statSync(outFile).size}`);
