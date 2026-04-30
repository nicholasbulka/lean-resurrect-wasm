#!/usr/bin/env bash
# Re-link lean.wasm preserving function names so we can identify which
# wasm-function[N] is trapping. emcc strips the `name` section by default
# under -O3; --profiling-funcs keeps function names only (small binary
# overhead, no full DWARF).
#
# Assumes everything else from the most recent build is on disk:
#   /work/build/stage1/lib/lean/lib{Init,Std,Lean,Lake,leanrt,leancpp}.a
#   /work/build/stage1/lib/temp/lib{leanmain,leanshell}.a
# The link binds them all into a fresh lean.wasm + lean.js with names.

set -euo pipefail

cd /work/build/stage1

# Mirror the original recipe (from stdlib.make:162) but add --profiling-funcs.
# Drop -DNDEBUG too — keeps assertions visible if we want trap-on-assert
# detail later. Output written next to the main artifact.
LEANC=/work/build/stage1/leanc.sh
LIB=/work/build/stage1/lib

EMCC_DEBUG_FLAGS="--profiling-funcs"

"$LEANC" \
  ../../build/stage1/lib/temp/libleanmain.a \
  -lstdc++ \
  ../../build/stage1/lib/temp/libleanshell.a \
  -lleancpp -lInit -lStd -lLean -lnodefs.js -lleanrt -lstdc++ \
  -s ALLOW_MEMORY_GROWTH=1 \
  -fwasm-exceptions \
  -pthread -matomics -mbulk-memory \
  -lnodefs.js \
  -s EXIT_RUNTIME=1 -s MAIN_MODULE=1 -s LINKABLE=1 -s EXPORT_ALL=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -I/work/build/stage1/include \
  -O3 \
  $EMCC_DEBUG_FLAGS \
  -o /work/build/stage1/bin/lean-named.js

ls -la /work/build/stage1/bin/lean-named.* | head
echo "[relink] done"
