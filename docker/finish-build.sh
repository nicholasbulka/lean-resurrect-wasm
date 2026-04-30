#!/usr/bin/env bash
# Finish the v4.27 WASM build manually after Lake-under-qemu deadlock.
#
# Lake hangs in futex_wait_queue right before re-archiving the static libs,
# leaving fresh .c.o.export objects and stale libInit.a/libStd.a/libLean.a/
# libLake.a/libLeanc.a. We re-archive them ourselves, then run the final
# emcc link to produce lean.wasm + lean.js + lean.worker.js.

set -euo pipefail
BUILD=/work/build/stage1
LIB=$BUILD/lib/lean
TEMP=$BUILD/lib/temp
EMAR=$EMSDK/upstream/emscripten/emar
EMCC=$EMSDK/upstream/emscripten/emcc

archive_pkg() {
  local pkg=$1
  local out=$LIB/lib${pkg}.a
  echo "[finish] archiving $pkg -> $out"
  # Top-level pkg.c.o.export + all subdir .c.o.export under pkg/
  local objs
  objs=$(
    { [ -f "$TEMP/${pkg}.c.o.export" ] && echo "$TEMP/${pkg}.c.o.export"; } ;
    find "$TEMP/$pkg" -name '*.c.o.export' 2>/dev/null
  )
  local n
  n=$(echo "$objs" | grep -c .)
  echo "[finish]   $n objects"
  rm -f "$out"
  # ar -rcs in chunks (cmdline limit)
  echo "$objs" | xargs $EMAR rcs "$out"
  ls -lh "$out"
}

archive_pkg Init
archive_pkg Std
archive_pkg Lean
archive_pkg Lake

# Leanc has its own dir
if [ -f "$TEMP/Leanc/Leanc.c.o.export" ]; then
  echo "[finish] archiving Leanc"
  $EMAR rcs $LIB/libLeanc.a $TEMP/Leanc/Leanc.c.o.export
fi

# LakeMain (from src/lake)
if [ -f "$TEMP/LakeMain.c.o.export" ]; then
  echo "[finish] archiving LakeMain"
  $EMAR rcs $LIB/libLakeMain.a $TEMP/LakeMain.c.o.export
fi

echo "[finish] running final emcc link..."
cd $BUILD/shell
# Mirror the link command Lake/CMake would produce.
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
  -s ALLOW_MEMORY_GROWTH=1 -fwasm-exceptions -pthread \
  -matomics -mbulk-memory \
  -lm -lnodefs.js \
  -s EXIT_RUNTIME=1 -s MAIN_MODULE=1 -s LINKABLE=1 -s EXPORT_ALL=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0

echo "[finish] artifacts:"
ls -lh $BUILD/bin/lean.{js,wasm,worker.js} 2>/dev/null || true
