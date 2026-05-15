#!/usr/bin/env bash
# Relink lean.wasm with MAXIMUM_MEMORY=4GB (wasm32 hard ceiling) so big
# Mathlib modules like Set.Prod can finish elaborating without OOMing on
# Emscripten's default 2GB cap. Same MT=ON + PROXY_TO_PTHREAD link
# semantics as finish-build.sh; just adds the memory ceiling.
#
# Run inside the lean-wasm-build container via scripts/docker-relink-4gb.sh.

set -euo pipefail

BUILD=/work/build/stage1
LIB=$BUILD/lib/lean
TEMP=$BUILD/lib/temp
EMCC=$EMSDK/upstream/emscripten/emcc

# The acorn-optimizer step parses the 119MB lean.js with Node's default
# 2GB heap and OOMs. All the other relink-*.sh scripts bump this; copy
# their value.
export NODE_OPTIONS="--max-old-space-size=12288"

cd $BUILD/shell
echo "[relink-4gb] final emcc link with MAXIMUM_MEMORY=4GB..."
$EMCC -o $BUILD/bin/lean.js \
  --whole-archive \
    $TEMP/libleanmain.a \
    $TEMP/libleanshell.a \
    $LIB/libleancpp.a \
    $LIB/libInit.a \
    $LIB/libStd.a \
    $LIB/libLean.a \
    $LIB/libleanrt.a \
  -L$LIB \
  $BUILD/libuv/src/libuv/libuv.a \
  -L$EMSDK/upstream/emscripten/cache/sysroot/lib \
  -sPROXY_TO_PTHREAD=1 -sPTHREAD_POOL_SIZE=4 \
  -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB \
  -fwasm-exceptions -pthread \
  -matomics -mbulk-memory \
  -lm -lnodefs.js \
  -s EXIT_RUNTIME=1 -s MAIN_MODULE=1 -s LINKABLE=1 -s EXPORT_ALL=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0

echo "[relink-4gb] artifacts:"
ls -lh $BUILD/bin/lean.{js,wasm,worker.js} 2>/dev/null || true
