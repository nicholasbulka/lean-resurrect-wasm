#!/usr/bin/env bash
# Phase 11.x final: rebuild C++ runtime WITH pthread (restore the
# flags relink-mtoff.sh stripped) but DROP PROXY_TO_PTHREAD so main
# stays on the suspendable JS thread. Then Lean's MT=ON elaborator
# code can call pthread_* successfully AND JSPI suspension on
# fd_read still works.
#
# Output: build-wasm/stage1/bin/lean-jspi-pt.{js,wasm}.

set -euo pipefail
git config --global --add safe.directory '*'
cd /work/build/stage1

# === 1. Restore -pthread / -matomics / -mbulk-memory in flags.make ===
echo "[jspi-pt] restoring pthread flags in flags.make..."
find /work/build/stage1 -name flags.make -print0 | while IFS= read -r -d '' f; do
  # Only add to CXX_FLAGS / C_FLAGS lines that don't already have it.
  if grep -qE "^(CXX|C)_FLAGS = " "$f" && ! grep -q " -pthread " "$f"; then
    sed -i -E '/^(CXX|C)_FLAGS = /s/$/ -pthread -matomics -mbulk-memory/' "$f"
  fi
done

# === 2. Restore in leanc.sh / leancxx.sh ===
echo "[jspi-pt] restoring pthread flags in leanc.sh, dropping PROXY_TO_PTHREAD..."
for s in /work/build/stage1/leanc.sh /work/build/stage1/leancxx.sh; do
  [ -f "$s" ] || continue
  # Drop PROXY_TO_PTHREAD if present
  sed -i -e 's/ -sPROXY_TO_PTHREAD=1//g' -e 's/ -sPTHREAD_POOL_SIZE=[0-9]*//g' "$s"
  # Add -pthread / -matomics / -mbulk-memory back if missing
  if ! grep -q " -pthread\b" "$s"; then
    sed -i 's# -L$root/lib/lean# -L$root/lib/lean -pthread -matomics -mbulk-memory#' "$s"
    sed -i 's# "$@"# "$@" -pthread -matomics -mbulk-memory#' "$s"
  fi
done

echo "[jspi-pt] verifying leanc.sh state..."
grep -E "pthread|PROXY|matomics|bulk-memory" /work/build/stage1/leanc.sh | head -3

# === 3. Rebuild C++ libs with pthread back in scope ===
echo "[jspi-pt] removing stale .o files..."
find /work/build/stage1/runtime  /work/build/stage1/kernel \
     /work/build/stage1/library  /work/build/stage1/util \
     /work/build/stage1/CMakeFiles/leancpp.dir \
     /work/build/stage1/CMakeFiles/leancpp_1.dir \
     /work/build/stage1/CMakeFiles/leanshell.dir \
     /work/build/stage1/CMakeFiles/leaninitialize.dir \
     /work/build/stage1/initialize \
     /work/build/stage1/shell \
  -name "*.o" -delete 2>/dev/null || true

echo "[jspi-pt] re-make leanrt + leanrt_initial-exec + leancpp + leancpp_1..."
make leanrt leanrt_initial-exec leancpp leancpp_1 -j 6

# === 4. Final link with USE_PTHREADS + JSPI, no PROXY_TO_PTHREAD ===
echo "[jspi-pt] final link with JSPI=1, JSPI_IMPORTS=fd_read..., JSPI_EXPORTS=main..."
export NODE_OPTIONS="--max-old-space-size=12288"
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
  -s USE_PTHREADS=1 \
  -s PTHREAD_POOL_SIZE=4 \
  -s JSPI=1 \
  -s JSPI_IMPORTS=fd_read,fd_write,fd_pread,fd_pwrite \
  -s JSPI_EXPORTS=main \
  -I/work/build/stage1/include \
  -O3 \
  --profiling-funcs \
  -o /work/build/stage1/bin/lean-jspi-pt.js

echo "[jspi-pt] done. Artifacts:"
ls -lh /work/build/stage1/bin/lean-jspi-pt.* | head
