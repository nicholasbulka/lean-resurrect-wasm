# src-overlay/

Files that get copied INTO `vendor/lean4-src/src/` before a Docker rebuild,
so we can introduce browser-specific entry points and CMake targets without
forking the upstream tree.

Layout mirrors `vendor/lean4-src/src/` exactly. Apply with:

```sh
rsync -a src-overlay/ vendor/lean4-src/src/
```

(Or done automatically by `docker/build-wasm.sh` when `OVERLAY=1` is set.)

## Status

| File | Status |
|---|---|
| `shell/lean_browser.cpp` | **DRAFT** — won't compile as-is. Skeleton + call-site sketch with TODO markers for headers, link order, and CMake target. Reflects findings from the source agent (`memory/in_browser_wasm_diagnosis.md`). |
| `shell/CMakeLists.txt.patch` | TBD — adds the `lean_browser` target and Emscripten link flags. |

The shipping fix for in-browser Lean is the `LEAN_MULTI_THREAD=OFF`
rebuild — that should make the existing `src/shell/lean.cpp` entry work
in-browser as-is. The lean_browser.cpp here is the *cleaner* long-term
design (no CLI argv plumbing, single Module.callMain replaced by direct
function exports), to be revisited once we have a working rebuilt binary.
