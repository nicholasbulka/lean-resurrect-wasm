#!/usr/bin/env bash
# Host-side wrapper to run the WASM build inside the Docker container.
# Usage:
#   scripts/docker-build.sh [LEAN_MULTI_THREAD=OFF] [PROXY_TO_PTHREAD=0]

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LEAN_SRC=$ROOT/vendor/lean4-src
BUILD_DIR=$ROOT/build-wasm
CCACHE_DIR=$ROOT/.ccache
IMAGE=lean-wasm-build

mkdir -p "$BUILD_DIR" "$CCACHE_DIR"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[host] building Docker image $IMAGE (one-time, ~15 min download + build)..."
  docker build -t "$IMAGE" "$ROOT/docker"
fi

if [ ! -d "$LEAN_SRC/src" ]; then
  echo "[host] no Lean source at $LEAN_SRC; clone leanprover/lean4 there first" >&2
  exit 2
fi

ARGS=()
ARGS+=( -e "LEAN_MULTI_THREAD=${LEAN_MULTI_THREAD:-OFF}" )
ARGS+=( -e "PROXY_TO_PTHREAD=${PROXY_TO_PTHREAD:-0}" )
ARGS+=( -e "JOBS=${JOBS:-$(sysctl -n hw.logicalcpu 2>/dev/null || nproc)}" )

echo "[host] starting container build..."
exec docker run --rm -it \
  -v "$LEAN_SRC":/work/lean4 \
  -v "$BUILD_DIR":/work/build \
  -v "$CCACHE_DIR":/cache/ccache \
  -v "$ROOT/docker":/work/scripts:ro \
  "${ARGS[@]}" \
  "$IMAGE" \
  bash /work/scripts/build-wasm.sh
