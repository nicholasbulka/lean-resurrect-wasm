#!/usr/bin/env bash
# Fix stage1 build flags from MT=ON to MT=OFF (the original cmake passed
# -DLEAN_MULTI_THREAD=OFF but the option is named MULTI_THREAD; the build
# silently kept MT=ON), force-rebuild affected .a files, then relink.
#
# Run inside the docker container.

set -euo pipefail

git config --global --add safe.directory '*'

cd /work/build/stage1

echo "[mtoff-relink] Fixing flags.make: drop -D LEAN_MULTI_THREAD, -pthread, -matomics, -mbulk-memory..."
# Patch every stage1 flags.make. CXX_FLAGS line gets the offending flags
# stripped. We don't touch stage0 (it's host-native, MT=ON is fine).
find /work/build/stage1 -name flags.make -print0 | while IFS= read -r -d '' f; do
  if grep -q "LEAN_MULTI_THREAD\| -pthread \| -matomics \| -mbulk-memory" "$f"; then
    echo "  - $f"
    sed -i \
      -e 's/ -D LEAN_MULTI_THREAD//g' \
      -e 's/ -pthread / /g' \
      -e 's/ -matomics / /g' \
      -e 's/ -mbulk-memory / /g' \
      -e 's/ -mbulk-memory$//g' \
      "$f"
  fi
done

# Also fix the leanc.sh script and leancxx.sh that passes flags at link time.
# Patterns: -pthread can appear with surrounding spaces, end-of-array `)`,
# end-of-line, or as a tail token. Cover all cases.
for s in /work/build/stage1/leanc.sh /work/build/stage1/leancxx.sh /work/build/stage1/lib/lean/lean.mk; do
  if [ -f "$s" ]; then
    if grep -q "LEAN_MULTI_THREAD\|-pthread\|-matomics\|-mbulk-memory" "$s"; then
      echo "[mtoff-relink] patching $s"
      sed -i \
        -e 's/ -D LEAN_MULTI_THREAD//g' \
        -e 's/ -pthread\b//g' \
        -e 's/ -matomics\b//g' \
        -e 's/ -mbulk-memory\b//g' \
        "$s"
    fi
  fi
done

# Delete .o files so they rebuild with new flags. Preserve .a so Init/Std/Lean
# (Lean-side compiled code) survive — those are wasm-feature-agnostic.
echo "[mtoff-relink] removing stale .o files in runtime, kernel, library, util..."
find /work/build/stage1/runtime  /work/build/stage1/kernel \
     /work/build/stage1/library  /work/build/stage1/util \
     /work/build/stage1/CMakeFiles/leancpp.dir \
     /work/build/stage1/CMakeFiles/leancpp_1.dir \
     /work/build/stage1/CMakeFiles/leanshell.dir \
     /work/build/stage1/CMakeFiles/leaninitialize.dir \
     /work/build/stage1/initialize \
     /work/build/stage1/shell \
  -name "*.o" -delete 2>/dev/null || true

echo "[mtoff-relink] re-make leanrt + leanrt_initial-exec + leancpp + leancpp_1..."
make leanrt leanrt_initial-exec leancpp leancpp_1 -j 6
echo "[mtoff-relink] C++ static libs rebuilt"

# Stdlib rebuild (only triggers for changed .lean files via Lake incremental).
echo "[mtoff-relink] make_stdlib (Lean src incremental)..."
make make_stdlib -j 6
echo "[mtoff-relink] make_stdlib done"

# Final link with --profiling-funcs preserved.
# acorn-optimizer (emcc internal tool that does --minify-whitespace) OOMs
# on the 119MB lean.js with the default 2GB Node heap; bump it. emcc
# inherits NODE_OPTIONS for the child Node it spawns.
export NODE_OPTIONS="--max-old-space-size=8192"
LEANC=/work/build/stage1/leanc.sh
chmod +x "$LEANC" || true
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
  -I/work/build/stage1/include \
  -O3 \
  --profiling-funcs \
  -o /work/build/stage1/bin/lean-fixed.js

ls -la /work/build/stage1/bin/lean-fixed.* | head
echo "[mtoff-relink] done"
