#!/usr/bin/env bash
# Phase 11.x fix: re-do the final link with -sPROXY_TO_PTHREAD stripped
# from leanc.sh. The C++ libs are already rebuilt without -pthread
# from the prior relink-jspi-mtoff.sh run; we just need a cleaner
# link that doesn't pull PROXY_TO_PTHREAD back in. Output:
# lean-jspi-st.{js,wasm}, OVERWRITING the prior failed attempt.

set -euo pipefail
cd /work/build/stage1

echo "[jspi-st-fix] stripping PROXY_TO_PTHREAD from leanc.sh..."
sed -i \
  -e 's/ -sPROXY_TO_PTHREAD=1//g' \
  -e 's/ -sPTHREAD_POOL_SIZE=[0-9]*//g' \
  /work/build/stage1/leanc.sh

echo "[jspi-st-fix] verifying..."
grep -E "PROXY_TO_PTHREAD|PTHREAD_POOL" /work/build/stage1/leanc.sh && echo "WARN: still present" || echo "OK: stripped"

echo "[jspi-st-fix] re-linking…"
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
  -s JSPI=1 \
  -s JSPI_IMPORTS=fd_read,fd_write,fd_pread,fd_pwrite \
  -s JSPI_EXPORTS=main \
  -I/work/build/stage1/include \
  -O3 \
  --profiling-funcs \
  -o /work/build/stage1/bin/lean-jspi-st.js

echo "[jspi-st-fix] done."
ls -lh /work/build/stage1/bin/lean-jspi-st.* | head
