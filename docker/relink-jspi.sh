#!/usr/bin/env bash
# Phase 11.0 plan B: relink lean.wasm with -sJSPI=1 (JavaScript Promise
# Integration — Asyncify=2). JSPI is V8-backed and compatible with
# -fwasm-exceptions, which legacy ASYNCIFY=1 is not. Output:
# lean-jspi.{js,wasm} alongside the existing artifacts.
#
# Prerequisites:
# - Browser: Chrome 122+ (V8 has JSPI support behind a flag in older,
#   on by default in 122+)
# - Node: 22+ with --experimental-wasm-stack-switching (or 23+ stable)
# - emsdk: 3.1.65+ (we have 3.1.74)
#
# Caveats:
# - JSPI is experimental; semantics may shift. Document any binary
#   produced with this flag as "experimental" and don't ship it as
#   the production compile binary.

set -euo pipefail

git config --global --add safe.directory '*'

cd /work/build/stage1

export NODE_OPTIONS="--max-old-space-size=12288"

LEANC=/work/build/stage1/leanc.sh
chmod +x "$LEANC" || true

echo "[jspi-relink] linking with -sJSPI=1 → bin/lean-jspi.{js,wasm}"

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
  -s JSPI=1 \
  -I/work/build/stage1/include \
  -O3 \
  --profiling-funcs \
  -o /work/build/stage1/bin/lean-jspi.js

echo "[jspi-relink] done. Artifacts:"
ls -lh /work/build/stage1/bin/lean-jspi.* | head
