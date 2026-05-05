#!/usr/bin/env bash
# Phase 11.x: combine relink-mtoff.sh's pthread-stripping with JSPI
# flags. Without -pthread / -matomics / -mbulk-memory, main runs on
# the main JS thread where the JSPI_EXPORTS=main promising wrapper
# is fully effective. The pthread interaction in PROXY_TO_PTHREAD
# breaks JSPI's stack-switching semantics — even with JSPI_EXPORTS=
# main, the pthread that runs Lean's watchdog isn't on a suspendable
# stack.
#
# Output: build-wasm/stage1/bin/lean-jspi-st.{js,wasm} (st = single-
# threaded). Does not clobber lean-jspi.{js,wasm} (the MT variant)
# or production lean.{js,wasm}.

set -euo pipefail

git config --global --add safe.directory '*'

cd /work/build/stage1

echo "[jspi-mtoff] Stripping -pthread / -matomics / -mbulk-memory from flags.make..."
find /work/build/stage1 -name flags.make -print0 | while IFS= read -r -d '' f; do
  if grep -q "LEAN_MULTI_THREAD\| -pthread \| -matomics \| -mbulk-memory" "$f"; then
    sed -i \
      -e 's/ -D LEAN_MULTI_THREAD//g' \
      -e 's/ -pthread / /g' \
      -e 's/ -matomics / /g' \
      -e 's/ -mbulk-memory / /g' \
      -e 's/ -mbulk-memory$//g' \
      "$f"
  fi
done

echo "[jspi-mtoff] Patching leanc.sh + lean.mk..."
for s in /work/build/stage1/leanc.sh /work/build/stage1/leancxx.sh /work/build/stage1/lib/lean/lean.mk; do
  if [ -f "$s" ]; then
    if grep -q "LEAN_MULTI_THREAD\|-pthread\|-matomics\|-mbulk-memory" "$s"; then
      sed -i \
        -e 's/ -D LEAN_MULTI_THREAD//g' \
        -e 's/ -pthread\b//g' \
        -e 's/ -matomics\b//g' \
        -e 's/ -mbulk-memory\b//g' \
        "$s"
    fi
  fi
done

echo "[jspi-mtoff] Removing stale .o files..."
find /work/build/stage1/runtime  /work/build/stage1/kernel \
     /work/build/stage1/library  /work/build/stage1/util \
     /work/build/stage1/CMakeFiles/leancpp.dir \
     /work/build/stage1/CMakeFiles/leancpp_1.dir \
     /work/build/stage1/CMakeFiles/leanshell.dir \
     /work/build/stage1/CMakeFiles/leaninitialize.dir \
     /work/build/stage1/initialize \
     /work/build/stage1/shell \
  -name "*.o" -delete 2>/dev/null || true

echo "[jspi-mtoff] Rebuilding C++ static libs (no pthread)..."
make leanrt leanrt_initial-exec leancpp leancpp_1 -j 6

echo "[jspi-mtoff] make_stdlib (Lean src incremental)..."
make make_stdlib -j 6

echo "[jspi-mtoff] Final link with JSPI=1 + JSPI_IMPORTS + JSPI_EXPORTS, no pthread..."
export NODE_OPTIONS="--max-old-space-size=12288"
LEANC=/work/build/stage1/leanc.sh
chmod +x "$LEANC" || true

# IMPORTANT: drop -pthread / PROXY_TO_PTHREAD here too. leanc.sh has
# been patched but the link command had -sPROXY_TO_PTHREAD=1 baked in
# from leanc.sh's wrapping. The relink-mtoff.sh script's link command
# already drops these. We keep the JSPI flags.
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
  -s JSPI_IMPORTS=__syscall_read,__syscall_writev,__syscall_pread64,__syscall_pwrite64 \
  -s JSPI_EXPORTS=main \
  -I/work/build/stage1/include \
  -O3 \
  --profiling-funcs \
  -o /work/build/stage1/bin/lean-jspi-st.js

echo "[jspi-mtoff] done. Artifacts:"
ls -lh /work/build/stage1/bin/lean-jspi-st.* | head
