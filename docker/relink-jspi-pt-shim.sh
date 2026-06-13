#!/usr/bin/env bash
# Option A milestone 1a: FINAL-LINK-ONLY relink of the JSPI+pthread Lean
# binary with the uv_spawn shim linked in via `-Wl,--wrap=uv_spawn`. Reuses
# the already-built C++ libs from the lean-jspi-pt build (NO C++ rebuild) —
# only the emcc link runs, so it's much faster than the full relink.
#
# Goal: prove the watchdog's uv_spawn call is intercepted by __wrap_uv_spawn
# (our shim logs "[uv-spawn-shim] __wrap_uv_spawn intercepted").
#
# Output: build-wasm/stage1/bin/lean-jspi-pt-shim.{js,wasm}.
# Shim source mounted at /work/shim/uv-spawn-shim.c.

set -euo pipefail
git config --global --add safe.directory '*'
cd /work/build/stage1

echo "[shim] compiling uv-spawn-shim.c ..."
emcc -O2 -pthread -matomics -mbulk-memory -fwasm-exceptions \
  -I/work/build/stage1/include \
  -c /work/shim/uv-spawn-shim.c -o /work/build/stage1/uv-spawn-shim.o

echo "[shim] final link with -Wl,--wrap=uv_spawn (no C++ rebuild) ..."
export NODE_OPTIONS="--max-old-space-size=12288"
LEANC=/work/build/stage1/leanc.sh
chmod +x "$LEANC" || true

"$LEANC" \
  ../../build/stage1/lib/temp/libleanmain.a \
  -lstdc++ \
  ../../build/stage1/lib/temp/libleanshell.a \
  -lleancpp -lInit -lStd -lLean -lnodefs.js -lleanrt -lstdc++ \
  /work/build/stage1/uv-spawn-shim.o \
  -Wl,--wrap=uv_spawn \
  -s ALLOW_MEMORY_GROWTH=1 \
  -fwasm-exceptions \
  -lnodefs.js \
  -s EXIT_RUNTIME=1 -s MAIN_MODULE=1 -s LINKABLE=1 -s EXPORT_ALL=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -s USE_PTHREADS=1 \
  -s PTHREAD_POOL_SIZE=4 \
  -s JSPI=1 \
  -s JSPI_IMPORTS=fd_read,fd_write,fd_pread,fd_pwrite \
  -s JSPI_EXPORTS=main \
  -I/work/build/stage1/include \
  -O3 \
  --profiling-funcs \
  -o /work/build/stage1/bin/lean-jspi-pt-shim.js

echo "[shim] done. Artifacts:"
ls -lh /work/build/stage1/bin/lean-jspi-pt-shim.* | head
