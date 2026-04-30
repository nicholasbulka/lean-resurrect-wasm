// SPDX: Apache-2.0  (matches Lean upstream)
//
// lean_browser.cpp — browser-embeddable entry point for Lean 4 under
// Emscripten. Status: DRAFT. Headers, exact symbol names, and CMake target
// still need verification against the rebuilt stage1 stdlib. See
// memory/in_browser_wasm_diagnosis.md and packages/ide/src/lib/leanWasm.ts
// for the JS-side companion.
//
// Why this exists:
//   - The CLI driver (`src/shell/lean.cpp` → `lean_main` in `src/util/shell.cpp`)
//     has an EM_ASM block that explicitly throws "this driver only runs under
//     Node.js" — fine for the Node harness, blocks browser use.
//   - The CLI passes argv through `lean_shell_main` (Lean code) which orchestrates
//     option parsing, task manager setup, and `runFrontend`.
//   - We can replicate the init steps ourselves and expose just two functions
//     to JS: `lean_browser_init()` (one-time) and `lean_browser_compile()`
//     (per-request, source already in MEMFS at /work/Input.lean).
//
// Compile-side prerequisites (in CMakeLists.txt patch):
//   - LEAN_MULTI_THREAD=OFF (or PTHREAD_POOL_SIZE=4 + PROXY_TO_PTHREAD=1).
//     Without this, lean_init_task_manager_using(0) below still avoids
//     spawning workers, but other code paths in the runtime (libuv loop,
//     scoped_task_manager destructor) may still trip on Emscripten gaps.
//   - Link with `leanshell` (the libleanshell.a built from src/util/shell.cpp
//     minus `lean_main`'s `EM_ASM` guard) plus stage0/stage1 oleans.
//   - Emscripten flags: -sEXPORTED_FUNCTIONS=['_lean_browser_init',
//     '_lean_browser_compile','_lean_browser_finalize','_malloc','_free']
//     -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','UTF8ToString','HEAPU8','FS']
//     -sMODULARIZE=1 (clean factory function for JS import).

#include <cstdio>
#include <cstring>
#include <vector>
#include <string>
#include <emscripten.h>

// Lean runtime + shell entry headers. Paths assume this file lives in
// src/shell/ alongside lean.cpp.
#include "runtime/object.h"
#include "runtime/io.h"
#include "library/init/init.h"
#include "util/list_ref.h"
#include "util/string_ref.h"
#include "util/object_ref.h"

namespace lean {

extern "C" {
  // Same set of externs the CLI uses (src/util/shell.cpp:222, :263, :222).
  obj_res lean_init_search_path();
  obj_res lean_enable_initializer_execution();
  void    lean_init_task_manager_using(unsigned num_workers);
  void    lean_finalize_task_manager();
  obj_res lean_shell_options_mk(obj_arg);

  // The Lean-side CLI driver. Defined in stage0/stdlib/Lean/Shell.c
  // as `LEAN_EXPORT lean_object* lean_shell_main(lean_object*, lean_object*)`.
  // Takes (args : List String, opts : ShellOptions), returns IO UInt32.
  obj_res lean_shell_main(obj_arg args_list, obj_arg shell_opts);
}

static initializer * g_init       = nullptr;
static object *      g_shell_opts = nullptr;

// Reverse-fold a vector of std::string into List String — newest-first
// because list_ref<>::cons builds backwards.
static list_ref<string_ref> mk_args_list(std::vector<std::string> const & args) {
  list_ref<string_ref> result;
  for (auto it = args.rbegin(); it != args.rend(); ++it) {
    result = list_ref<string_ref>(string_ref(*it), result);
  }
  return result;
}

// One-time Lean runtime initialization. Called on first compile or
// explicitly from JS to amortize the cost away from the user-visible
// compile latency.
extern "C" EMSCRIPTEN_KEEPALIVE
int lean_browser_init() {
  if (g_init != nullptr) return 0;
  g_init = new initializer();

  // num_workers=0 → tasks execute inline on the calling thread. This avoids
  // the v4.15 hang where a single worker pthread is created but main can't
  // yield to it under Emscripten. With LEAN_MULTI_THREAD=OFF in the build,
  // this is also a no-op since lthread becomes inline.
  lean_init_task_manager_using(0);

  consume_io_result(lean_init_search_path());
  consume_io_result(lean_enable_initializer_execution());

  // Default shell options. The CLI populates these from getopt-parsed argv;
  // we use defaults and rely on the CLI's --json arg to be parsed by
  // lean_shell_main itself.
  g_shell_opts = lean_shell_options_mk(box(0));
  return 0;
}

// Run a compile of /work/Input.lean (which the JS caller wrote to MEMFS).
// Returns Lean's exit code (0 = ok, 1 = errors).
//
// JS-side flow:
//   1. await ensureLeanLoaded()
//   2. FS.writeFile('/work/Input.lean', sourceBytes)
//   3. Module.ccall('lean_browser_compile', 'number', [], [])
//   4. read Module.print captures for stdout (JSON-line diagnostics)
extern "C" EMSCRIPTEN_KEEPALIVE
int lean_browser_compile() {
  if (g_init == nullptr) lean_browser_init();

  std::vector<std::string> args = {
    "--json",            // structured diagnostics
    "--root=/work",      // module root for import resolution
    "/work/Input.lean",  // staged by the JS caller
  };
  auto args_list = mk_args_list(args);

  // lean_shell_main returns IO UInt32; unwrap to a host int.
  obj_res raw = lean_shell_main(
    args_list.steal(),
    object_ref(g_shell_opts, /* incref */ true).to_obj_arg()
  );
  uint32_t rc = get_io_scalar_result<uint32>(raw);
  return static_cast<int>(rc);
}

extern "C" EMSCRIPTEN_KEEPALIVE
void lean_browser_finalize() {
  if (g_shell_opts) { dec(g_shell_opts); g_shell_opts = nullptr; }
  if (g_init)       { delete g_init;     g_init       = nullptr; }
  lean_finalize_task_manager();
}

} // namespace lean
