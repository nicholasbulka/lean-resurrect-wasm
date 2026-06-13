/* Option A: link-level override of libuv's uv_spawn for the Lean LSP
 * watchdog under WASM. SKELETON — starting point, not yet wired to a build.
 *
 * Why a C shim and not a JS override (see OPTION-A-PLAN.md): _uv_spawn /
 * _posix_spawn are compiled wasmExports, and there are no fork/exec syscall
 * imports to hook. Internal wasm→wasm calls to uv_spawn can't be caught in
 * JS. The clean interception is at LINK time via `-Wl,--wrap=uv_spawn`: the
 * linker rewrites callers to __wrap_uv_spawn and exposes the original as
 * __real_uv_spawn. We never touch libuv source.
 *
 * Build hook (to add in docker/relink-jspi-pt.sh's link step):
 *   emcc ... uv-spawn-shim.c -Wl,--wrap=uv_spawn \
 *            -Wl,--wrap=uv_process_kill -Wl,--wrap=uv_pipe_open ...
 *
 * The EM_JS bodies call into JS land (tools/lsp-spike runtime) which:
 *   1. allocates two SAB ring-buffer pipes (sab-pipe.mjs),
 *   2. starts a Worker running the same lean.wasm with the --worker argv,
 *   3. wires the worker's stdin/stdout to the SABs,
 *   4. returns a synthetic pid the watchdog can later "kill".
 * The watchdog's libuv pipe reads/writes then flow over the SABs, driven by
 * the already-proven JSPI fd_read/fd_write suspension on both sides.
 */

#include <emscripten.h>
#include <stdint.h>

/* libuv handle/loop/options are opaque here; we forward the raw pointers to
 * JS and let the JS side read what it needs from HEAPU8 via the known libuv
 * struct offsets (TODO: pin offsets from the built libuv, or include uv.h
 * and pass typed fields). Returns 0 on success, like uv_spawn. */
EM_JS(int, lean_shim_spawn, (uintptr_t loop, uintptr_t handle, uintptr_t options), {
  // MILESTONE 1a: prove the --wrap interception fires. Log, then defer to
  // the JS worker launcher if wired, else return ENOSYS (same as before,
  // but now from OUR path — the log is the proof of interception).
  try { console.error('[uv-spawn-shim] __wrap_uv_spawn intercepted: loop=' + loop + ' handle=' + handle + ' options=' + options); } catch (e) {}
  // TODO(option-a 1b): read argv/cmd from `options` (uv_process_options_t),
  // start a Worker with ['--worker', ...args, uri], allocate SAB pipes,
  // store {pid -> worker, stdinPipe, stdoutPipe} in a JS registry, and
  // back-patch the uv_process_t `handle` pid field. Return 0.
  return (typeof Module !== 'undefined' && Module.__leanSpawnWorker)
    ? Module.__leanSpawnWorker(loop, handle, options)
    : 52 /* UV_ENOSYS until wired */;
});

EM_JS(int, lean_shim_process_kill, (uintptr_t handle, int signum), {
  return (typeof Module !== 'undefined' && Module.__leanKillWorker)
    ? Module.__leanKillWorker(handle, signum)
    : 0;
});

/* --wrap targets ---------------------------------------------------------- */
extern int __real_uv_spawn(uintptr_t loop, uintptr_t handle, uintptr_t options);
extern int __real_uv_process_kill(uintptr_t handle, int signum);

int __wrap_uv_spawn(uintptr_t loop, uintptr_t handle, uintptr_t options) {
  return lean_shim_spawn(loop, handle, options);
}

int __wrap_uv_process_kill(uintptr_t handle, int signum) {
  return lean_shim_process_kill(handle, signum);
}

/* TODO: uv_pipe_open / uv_read_start / uv_write wrappers if the default
 * libuv pipe path can't be pointed at the SAB fds directly. Prefer pointing
 * libuv at a real Emscripten pipe fd whose backing is our SAB, to reuse
 * libuv's existing read/write machinery and minimize the wrap surface. */
