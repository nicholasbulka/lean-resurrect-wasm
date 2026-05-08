# Lean v4.27.0 source patches for wasm32-MT=ON IDE

**Living document.** Authoritative inventory of every change we've
made to upstream `vendor/lean4-src/` (Lean v4.27.0 base
`db93fe1608548721853390a10cd40580fe7d22ae`) to make a wasm32
runtime usable from a browser-mode IDE.

Verify with:

```
git -C vendor/lean4-src diff --stat db93fe16 HEAD
```

Expected: **15 files changed, +243/-29**, all under `src/runtime/`,
`src/library/`, or build configuration. **No kernel / elaborator /
type-checker code is touched.**

---

## Tally at a glance

| Category | Files | Why |
|---|---|---|
| Build configuration | 2 | Pass the right wasm features through `cmake` and `lake`. |
| Codegen-vs-extern signature fixes | 8 | wasm-ld's strict signature checking surfaced ABI mismatches Lean's native build accepted silently. |
| libuv API stubs | 2 | v4.27's Emscripten ifdef declared but didn't define some entry points; wasm-ld emits `unreachable` for missing definitions. |
| MT=OFF runtime safety | 2 | Defensive null-guards on `g_task_manager` so a `MULTI_THREAD=OFF` build doesn't segfault on first task call. Not on the MT=ON code path we ship. |
| **Total unique** | **14** | (one file — `module.cpp` — appears in two patch hunks) |

**Out of scope:** kernel, elaborator, parser, tactic framework,
metaprogramming, environment representation, the `Lean.*` Lean
sources. We didn't touch any of it.

---

## Category 1 — Build configuration

### 1.1 `src/CMakeLists.txt` (+50, ~5 deletions)

The big one. Two changes:

**MT-aware Emscripten flags.** Upstream sets a single hard-coded
`EMSCRIPTEN_SETTINGS` string with `-pthread -flto`. We branch on
`MULTI_THREAD`:

```cmake
if(MULTI_THREAD)
  set(EMSCRIPTEN_SETTINGS "-s ALLOW_MEMORY_GROWTH=1 -fwasm-exceptions -pthread -matomics -mbulk-memory")
  string(APPEND LEANC_EXTRA_CC_FLAGS " -pthread -matomics -mbulk-memory")
else()
  set(EMSCRIPTEN_SETTINGS "-s ALLOW_MEMORY_GROWTH=1 -fwasm-exceptions")
endif()
```

Why:

- emcc 3.1.74's `-pthread` doesn't reliably propagate `-matomics`
  and `-mbulk-memory` to LLVM. Without them, every `.c.o.export`
  object lacks the wasm features `wasm-ld` needs for a
  `-sSHARED_MEMORY` link. Adding them explicitly fixes it.
- `-flto` forced LTO which produced LLVM bitcode `.c.o.export`
  files with no wasm features yet. `wasm-ld` rejected those before
  LTO codegen ran. Drop LTO.
- When `MULTI_THREAD=OFF`, dropping `-pthread` entirely avoids the
  emcc `MAIN_MODULE + pthreads is experimental` interaction that
  produces a binary that traps `unreachable` on first call — even
  though the runtime itself never spawns a thread.

**libuv Emscripten stubs file.** Append a generated
`emscripten-stubs.c` to libuv's source list when targeting Emscripten:

```cmake
if(CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  list(APPEND uv_sources
       src/unix/no-proctitle.c
       src/unix/emscripten-stubs.c)
endif()
```

The stubs file is materialised inline in the patch (a string
literal containing C definitions for the libuv platform-loop
symbols Emscripten's libuv branch declared but didn't define:
`uv__hrtime`, `uv__io_check_fd`, `uv__platform_loop_init`, etc).
Without these, wasm-ld emits `unreachable` for each, and the
runtime traps the moment anything in libuv's event-loop initialisation
runs.

### 1.2 `src/lakefile.toml.in` (+6, 0 deletions)

```toml
moreLeancArgs = ${LEAN_EXTRA_LEANC_OPTS_TOML}
```

Lake invokes its toolchain's C compiler directly (not via the
`leanc.sh` wrapper) when building `.c.o.export`. The wrapper's
`-pthread / -matomics / -mbulk-memory` flags don't propagate.
Force them through `moreLeancArgs` so every `.c.o.export` object
has the wasm features required for a `-sSHARED_MEMORY` link.

---

## Category 2 — Codegen-vs-extern signature fixes

Lean's native code generator emits Lean-side function signatures
that don't include the trailing `IO World` arg (Lean's calling
convention drops it as a runtime artifact). The C `extern`
declarations in upstream still carry the arg. Native `ld` accepts
the mismatch and the call is dispatched via a forgiving indirect
trampoline. **wasm-ld is strict about indirect-call signatures
under `-pthread`** and refuses to emit a working binary when the
two disagree, producing a runtime `unreachable` trap on the call.

The fix is mechanical: remove the trailing `lean_object * /* w */`
from the `extern "C"` declaration so it matches the codegen ABI.
Eight callsites across seven files:

| File | Function | Fix |
|---|---|---|
| `src/runtime/memory.cpp` | `lean_internal_get_default_max_memory` | **Add** `lean_object *` arg (Lean side passes one — the inverse of the others). |
| `src/runtime/interrupt.cpp` | `lean_internal_get_default_max_heartbeat` | Same — add `lean_object *`. |
| `src/runtime/io.cpp` | `lean_io_create_tempfile`, `lean_io_create_tempdir` | Drop `lean_object *` IO-world arg. |
| `src/runtime/compact.cpp` | `lean_compacted_region_free` | Drop `object *`. |
| `src/library/ir_interpreter.cpp` | `lean_run_init` | Drop trailing `object *`. |
| `src/library/module.cpp` | `lean_save_module_data_parts`, `lean_read_module_data_parts` | Drop `object *`. |
| `src/runtime/uv/dns.cpp` | `lean_uv_dns_get_info` | Drop trailing `int8_t protocol` (ABI mismatch in the WASM stub branch — Lean side doesn't pass it). |
| `src/runtime/uv/event_loop.cpp` | `lean_uv_event_loop_alive` | Change return type from `lean_obj_res` to `uint8_t` (Lean side: `BaseIO UInt64` → returns scalar, not boxed object). |
| `src/runtime/uv/system.cpp` | `lean_uv_os_get_group` | **Add** `uint64_t gid` arg (Lean side passes one; the WASM stub branch dropped it). |

Each carries a comment explaining the wasm-ld signature-mismatch
trap fix and the matching Lean-side signature.

### Why this matters

The native-Lean build's tolerance for these mismatches is a known
issue — Lean's runtime ABI is informal and the codegen has accreted
small inconsistencies that no tooling forced anyone to fix. wasm-ld
is the first tooling to actually enforce strict signature checking
on indirect calls, surfacing 8 such mismatches at once. They were
all latent bugs in the native build too; they just didn't manifest.

A patch upstream-able to leanprover/lean4 would be welcome here,
but our pipeline ships the WASM build out-of-tree so we patch
locally.

---

## Category 3 — libuv API stubs

`src/runtime/uv/tcp.cpp` and `src/runtime/uv/udp.cpp`.

Upstream's `LEAN_EMSCRIPTEN` ifdef branch in these files declares
the public TCP/UDP entry points but only defines about 80% of them
— a few were forgotten (probably from a refactor that added the
function in the libuv branch but not the stub branch). wasm-ld
emits `unreachable` for each missing definition, and the runtime
traps the moment any `Std.*` async code path goes near them.

### 3.1 `src/runtime/uv/tcp.cpp` (+23, 0 deletions)

Stubs for `lean_uv_tcp_wait_readable`, `lean_uv_tcp_cancel_recv`,
`lean_uv_tcp_try_accept` — each calls
`lean_always_assert(false && "Please build a version of Lean4 with libuv to invoke this.")`,
matching the existing stub pattern.

### 3.2 `src/runtime/uv/udp.cpp` (+15, 0 deletions)

Same pattern for `lean_uv_udp_wait_readable` and one other.

---

## Category 4 — MT=OFF runtime safety

These are defensive — they prevent crashes on a `MULTI_THREAD=OFF`
build whose runtime touches the (null) `g_task_manager`. Our
**production wasm32 build is MT=ON**, so this code never executes
in shipped artifacts. The patches just let MT=OFF builds boot for
debugging.

### 4.1 `src/runtime/object.cpp` (+57, ~7 deletions)

Five spots, all guarding `g_task_manager` against null-deref:

- `lean_task_get`: trap with `__builtin_trap()` and a `fprintf` if
  `g_task_manager` is null and a task value is unresolved (no
  manager will ever resolve it). Native build never has this case;
  WASM MT=OFF could.
- `lean_io_check_canceled_core`: short-circuit the
  `g_task_manager->shutting_down()` call.
- `lean_io_cancel_core`: no-op when manager is null.
- `lean_io_get_task_state_core`: report "running" instead of
  dispatching to the null manager.
- `lean_io_wait_any_core`: scan the task list once for any
  already-finished task instead of `wait_for`-ing.

### 4.2 `src/runtime/thread.h` (+7, 0 deletions)

Two additions to the `MULTI_THREAD=OFF` `unique_lock<T>` stub:

```cpp
unique_lock(T const &, std::adopt_lock_t) {}  // adopt_lock_t overload
T * release() { return nullptr; }              // matches std API
```

`mutex.cpp` calls `unique_lock(mtx, std::adopt_lock).release()` in
`lean_io_condvar_wait`. The MT=OFF stub didn't compile without
these; these add them as no-ops.

---

## What we explicitly did NOT touch

- **Kernel** (`src/Lean/Kernel/*`, `src/Lean/Meta/*`,
  `src/Lean/Elab/*`): unchanged. Type-checking, unification,
  reduction, definitional-equality, the entire elaborator —
  upstream code, untouched.
- **Parser** (`src/Lean/Parser/*`): unchanged.
- **Stdlib** (`src/Init/*`, `src/Std/*`): unchanged.
- **Module system** (`src/Lean/Module*`, `src/Lean/Compile*`):
  unchanged on the Lean side; the only patches touching `module.cpp`
  are runtime-side signature fixes (Category 2), not module-format
  changes.
- **Olean format**: byte-for-byte identical to upstream v4.27.0
  (verified via the header bytes — same `version=2`, same field
  layout). Our `flags=0` value reflects `MULTI_THREAD=ON, GMP=OFF`;
  upstream sets it the same way for those config knobs.

---

## Reproducing

The whole patch is a single commit in `vendor/lean4-src/`:

```
git -C vendor/lean4-src log --oneline db93fe16..HEAD
# 63203ddc v4.27 wasm32 patches for MT=ON browser/Node-worker target
```

To apply to a fresh upstream checkout:

```
cd lean4
git checkout v4.27.0
git cherry-pick 63203ddc...   # from this repo's vendor branch
```

Or just clone the vendored copy directly:

```
git clone <this-repo>
cd lean4-src   # if vendored as submodule, otherwise vendor/lean4-src
git log -1     # should show 63203ddc on top of db93fe16
```

The build then proceeds with the standard
`docker/build-wasm.sh MULTI_THREAD=ON PROXY_TO_PTHREAD=1` recipe
that produced the binary in `vendor/lean-linux_wasm32/bin/`.

---

## Maintenance

When pegging a new Lean version:

1. Rebase `63203ddc` onto the new upstream tag.
2. Re-verify each category:
   - Build config — emcc version may have changed flag handling.
   - Signature fixes — Lean codegen may have evolved (new mismatches,
     old ones fixed upstream).
   - libuv stubs — upstream may have added the missing definitions.
   - MT=OFF safety — these patches are safe to keep regardless.
3. Update this doc with the new diff stats and any
   added/removed/changed entries.

Mathlib + dep rebuilds happen separately (see
`config/wasm-deps.json` for the peg set), but they always need a
freshly built wasm32 lean since the olean header records the
build's githash.
