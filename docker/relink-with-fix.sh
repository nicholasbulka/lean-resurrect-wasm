#!/usr/bin/env bash
# Re-build only the two cpp files we patched (memory.cpp, interrupt.cpp),
# re-archive into libleanrt.a + libleanrt_initial-exec.a, then re-link
# lean.wasm with --profiling-funcs preserved.

set -euo pipefail

# Bind-mounted dirs have host uid/gid which git refuses to operate on
# unless whitelisted. ExternalProject_Add for libuv uses git apply.
git config --global --add safe.directory '*'

cd /work/build/stage1

# Recompile any cpp file that's been touched (memory.cpp + interrupt.cpp +
# compact.cpp + io.cpp in runtime/, module.cpp + ir_interpreter.cpp in
# library/). The two top-level targets pull in everything they depend on.
echo "[fix-relink] re-compiling stale cpp + relinking..."
make leanrt leanrt_initial-exec leancpp leancpp_1 -j 6
echo "[fix-relink] static libs rebuilt"

# Now redo the final lean.wasm link with --profiling-funcs to keep names.
LEANC=/work/build/stage1/leanc.sh
# Drop -pthread / -matomics / -mbulk-memory from the link: build is
# LEAN_MULTI_THREAD=OFF so the C++ side is single-threaded, and including
# -pthread at link would pull in `_emscripten_proxy_main` which dispatches
# main to a pthread that we don't actually want. With these flags off the
# entry stays as plain `_main`, callMain returns the real exit code.
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
echo "[fix-relink] done"
