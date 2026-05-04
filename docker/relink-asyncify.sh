#!/usr/bin/env bash
# Phase 11.0: relink lean.wasm with -sASYNCIFY=1 so Module.stdin can
# return a Promise. Output: lean-asyncify.{js,wasm} alongside the
# existing artifacts. Does NOT clobber the production lean.{js,wasm}.
#
# Asyncify rewrites the WASM at link time so blocking JS imports can
# yield. The cost: bigger wasm (~50-100% larger), slower runtime
# (~30-50% perf hit). Acceptable for an LSP companion binary.
#
# Caveat: ASYNCIFY+PTHREAD is officially unsupported. We assume the
# build state has -pthread / -matomics / -mbulk-memory already stripped
# (e.g., from a prior relink-mtoff.sh run). If those flags are present
# in flags.make, run relink-mtoff.sh first.
#
# Run inside the docker container via:
#   docker run --rm -v $ROOT/vendor/lean4-src:/work/lean4 \
#     -v $ROOT/build-wasm:/work/build -v $ROOT/.ccache:/cache/ccache \
#     -v $ROOT/docker:/work/scripts:ro lean-wasm-build \
#     bash /work/scripts/relink-asyncify.sh

set -euo pipefail

git config --global --add safe.directory '*'

cd /work/build/stage1

# acorn-optimizer / wasm-opt minify chain OOMs the default Node 2GB heap
# on lean.js (~120MB). Bump it; ASYNCIFY makes the JS even larger.
export NODE_OPTIONS="--max-old-space-size=12288"

LEANC=/work/build/stage1/leanc.sh
chmod +x "$LEANC" || true

echo "[asyncify-relink] linking with -sASYNCIFY=1 → bin/lean-asyncify.{js,wasm}"
echo "[asyncify-relink] (this is a probe; if it fails we learn what blocks)"

# Same link as relink-mtoff.sh, plus ASYNCIFY flags. Output filename
# changed to avoid clobbering existing binaries.
"$LEANC" \
  ../../build/stage1/lib/temp/libleanmain.a \
  -lstdc++ \
  ../../build/stage1/lib/temp/libleanshell.a \
  -lleancpp -lInit -lStd -lLean -lnodefs.js -lleanrt -lstdc++ \
  -s ALLOW_MEMORY_GROWTH=1 \
  -fwasm-exceptions \
  -lnodefs.js \
  -s EXIT_RUNTIME=1 -s MAIN_MODULE=1 -s LINKABLE=1 -s EXPORT_ALL=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -s ASYNCIFY=1 \
  -s ASYNCIFY_STACK_SIZE=16384 \
  -I/work/build/stage1/include \
  -O3 \
  --profiling-funcs \
  -o /work/build/stage1/bin/lean-asyncify.js

echo "[asyncify-relink] done. Artifacts:"
ls -lh /work/build/stage1/bin/lean-asyncify.* | head
