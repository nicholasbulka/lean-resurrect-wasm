# Docker dev environment for Lean WASM

Why: stage0 of Lean's WASM build is a 32-bit x86 native compile (uses `-m32`).
On Apple Silicon macOS this is a mess; on x86 macOS it's still fragile.
A Linux container is the sane path.

## One-time setup

```sh
docker build -t lean-wasm-build docker/
```

Image is ~2 GB (Ubuntu 22.04 + emsdk 3.1.74 + build-essential + cmake + multilib).
Caches the emsdk install so the slow part is once-only.

## Build Lean from source

```sh
scripts/docker-build.sh
```

Mounts `vendor/lean4-src` (source), `build-wasm/` (build dir, persists across
runs), and `.ccache/` (compiler cache). First clean build is multi-hour;
incremental rebuilds are minutes.

## Knobs

```sh
LEAN_MULTI_THREAD=OFF   scripts/docker-build.sh   # default; safest in browser
LEAN_MULTI_THREAD=ON    scripts/docker-build.sh   # original config
PROXY_TO_PTHREAD=1      scripts/docker-build.sh   # alt fix: main() in a pthread
```

The shipped v4.15 `linux_wasm32` was likely built with `LEAN_MULTI_THREAD=ON`
and no `PROXY_TO_PTHREAD`. Our diagnosis is that this combination causes a
busy-wait deadlock on the browser main thread when elaboration enqueues work
for the worker pthread. `LEAN_MULTI_THREAD=OFF` collapses tasks back to the
calling thread and should sidestep it; `PROXY_TO_PTHREAD=1` keeps threads but
relocates `main()` so it can `Atomics.wait` legally.

## Artifacts

After build:

```
build-wasm/shell/lean.js
build-wasm/shell/lean.wasm
build-wasm/shell/lean.worker.js   (only with -pthread)
```

Copy or symlink into `vendor/` and reload the harness to test:

```sh
cp build-wasm/shell/lean.js   vendor/lean-linux_wasm32/bin/
cp build-wasm/shell/lean.wasm vendor/lean-linux_wasm32/bin/
```
