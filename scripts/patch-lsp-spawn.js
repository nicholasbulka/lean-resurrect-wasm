#!/usr/bin/env node
// Option A milestone 1b: patch Lean's runtime spawn (process.cpp) so the
// emscripten build can intercept process creation. Lean's WASM spawn uses
// raw fork()+execvp() (the POSIX #else branch), which Emscripten stubs →
// ENOSYS → the LSP watchdog dies when it tries to spawn a --worker.
//
// Minimal + forward-compatible design: insert a single EM_JS PROBE call at
// the real spawn site. The probe logs the argv and delegates to a JS hook
// (Module.__leanSpawnWorker) — so the actual Web-Worker launch + SAB-pipe
// wiring can be iterated entirely in JS WITHOUT another 25-min rebuild. Only
// this hook point needs the rebuild.
//
// Idempotent. Usage: node scripts/patch-lsp-spawn.js [path/to/process.cpp]

const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] ||
  path.resolve(__dirname, '../vendor/lean4-src/src/runtime/process.cpp');
let src = fs.readFileSync(file, 'utf8');

const MARKER = 'lean_em_spawn_probe';
if (src.includes(MARKER)) {
  console.log('[patch-lsp-spawn] already patched:', file);
  process.exit(0);
}

// 1. EM_JS probe at file scope (before `namespace lean {`).
const incAnchor = '#include "runtime/buffer.h"\n';
if (!src.includes(incAnchor)) throw new Error('include anchor not found');
const emjs = incAnchor +
`
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// Option A: bridge Lean's process spawn to a JS worker launcher. The real
// launch (new Worker(--worker) + SAB-backed pipe fds) lives in JS so it can
// be iterated without rebuilding. Milestone 1b: probe fires + logs argv.
EM_JS(void, lean_em_spawn_probe, (const char* cmd, const char* args), {
  try {
    var c = UTF8ToString(cmd), a = UTF8ToString(args);
    try { console.error('[spawn-probe] cmd=' + c + ' args=' + a); } catch (e) {}
    if (typeof Module !== 'undefined' && Module['__leanSpawnWorker']) {
      Module['__leanSpawnWorker'](c, a);
    }
  } catch (e) {
    try { console.error('[spawn-probe] error: ' + e); } catch (_) {}
  }
});
#endif
`;
src = src.replace(incAnchor, emjs);

// 2. Call the probe just before the POSIX fork().
const forkAnchor = '    int pid = fork();\n';
if (!src.includes(forkAnchor)) throw new Error('fork anchor not found');
const probeCall =
`#ifdef __EMSCRIPTEN__
    {
        std::string __lean_argbuf;
        for (auto & __lean_a : args) { __lean_argbuf += __lean_a.data(); __lean_argbuf += " "; }
        lean_em_spawn_probe(proc_name.data(), __lean_argbuf.c_str());
    }
#endif
` + forkAnchor;
src = src.replace(forkAnchor, probeCall);

fs.writeFileSync(file, src);
console.log('[patch-lsp-spawn] patched:', file);
