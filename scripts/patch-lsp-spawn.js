#!/usr/bin/env node
// Option A milestone 1b-ii: patch Lean's runtime spawn (process.cpp) so the
// emscripten build replaces fork()+execvp() with a JS-launched Web Worker.
//
// Lean's WASM spawn uses raw fork()+execvp() (POSIX #else branch), which
// Emscripten stubs → ENOSYS → the LSP watchdog dies spawning a --worker.
//
// This patch, under __EMSCRIPTEN__, asks JS (Module.__leanSpawnWorker) to
// launch a worker and hand back stdin/stdout/stderr fd numbers (emscripten
// FS fds backed by SAB pipes). If JS returns a pid>0 we build the SAME child
// object the fork path builds (so the watchdog's fdopen/read/write Just Work)
// and RETURN, skipping fork. If JS declines (pid<=0) we fall through to the
// original fork (which ENOSYS's) — so the patch is safe even before the JS
// launcher is wired.
//
// ABI is pointer-free (no HEAP writes from EM_JS): lean_em_spawn returns the
// pid and stashes the fds; lean_em_last_fd(which) reads them back.
//
// Idempotent. Usage: node scripts/patch-lsp-spawn.js [path/to/process.cpp]

const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2] ||
  path.resolve(__dirname, '../vendor/lean4-src/src/runtime/process.cpp');
let src = fs.readFileSync(file, 'utf8');

const MARKER = 'lean_em_spawn';
if (src.includes(MARKER)) {
  console.log('[patch-lsp-spawn] already patched:', file);
  process.exit(0);
}

// 1. EM_JS bridges at file scope (before `namespace lean {`).
const incAnchor = '#include "runtime/buffer.h"\n';
if (!src.includes(incAnchor)) throw new Error('include anchor not found');
const emjs = incAnchor +
`
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
// Bridge Lean's process spawn to a JS worker launcher. The real launch
// (new Worker(--worker) + SAB-backed pipe fds) lives in JS so it can be
// iterated without rebuilding. Returns pid (>0) or -1 to fall back to fork.
// Args are newline-separated. fds are read back via lean_em_last_fd to keep
// the ABI pointer-free (no EM_JS HEAP writes).
EM_JS(int, lean_em_spawn, (const char* cmd, const char* args), {
  try {
    var c = UTF8ToString(cmd), a = UTF8ToString(args);
    if (typeof Module === 'undefined' || !Module['__leanSpawnWorker']) {
      try { console.error('[em-spawn] no launcher; falling back to fork: ' + c); } catch (e) {}
      return -1;
    }
    var r = Module['__leanSpawnWorker'](c, a) || {};
    Module['__leanLastSpawn'] = r;
    return (r.pid && r.pid > 0) ? (r.pid | 0) : -1;
  } catch (e) {
    try { console.error('[em-spawn] error: ' + e); } catch (_) {}
    return -1;
  }
});
EM_JS(int, lean_em_last_fd, (int which), {
  var r = Module['__leanLastSpawn'] || {};
  var v = which === 0 ? r.inFd : which === 1 ? r.outFd : r.errFd;
  return (v != null) ? (v | 0) : -1;
});
#endif
`;
src = src.replace(incAnchor, emjs);

// 2. Try the JS launcher just before the POSIX fork(); on success build the
//    child object exactly like the fork path and return.
const forkAnchor = '    int pid = fork();\n';
if (!src.includes(forkAnchor)) throw new Error('fork anchor not found');
const inject =
`#ifdef __EMSCRIPTEN__
    {
        std::string __lean_argbuf;
        for (auto & __lean_a : args) { __lean_argbuf += __lean_a.data(); __lean_argbuf += "\\n"; }
        int __em_pid = lean_em_spawn(proc_name.data(), __lean_argbuf.c_str());
        if (__em_pid > 0) {
            int __in_fd  = lean_em_last_fd(0);
            int __out_fd = lean_em_last_fd(1);
            int __err_fd = lean_em_last_fd(2);
            object * parent_stdin  = (__in_fd  >= 0) ? io_wrap_handle(fdopen(__in_fd,  "w")) : box(0);
            object * parent_stdout = (__out_fd >= 0) ? io_wrap_handle(fdopen(__out_fd, "r")) : box(0);
            object * parent_stderr = (__err_fd >= 0) ? io_wrap_handle(fdopen(__err_fd, "r")) : box(0);
            object_ref __r = mk_cnstr(0, parent_stdin, parent_stdout, parent_stderr, sizeof(pid_t) + sizeof(uint8_t));
            cnstr_set_uint32(__r.raw(), 3 * sizeof(object *), (uint32)__em_pid);
            cnstr_set_uint8(__r.raw(), 3 * sizeof(object *) + sizeof(pid_t), do_setsid);
            return lean_io_result_mk_ok(__r.steal());
        }
    }
#endif
` + forkAnchor;
src = src.replace(forkAnchor, inject);

fs.writeFileSync(file, src);
console.log('[patch-lsp-spawn] patched (return-path):', file);
