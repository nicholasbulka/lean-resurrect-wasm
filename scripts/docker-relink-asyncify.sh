#!/usr/bin/env bash
# Host-side wrapper: run docker/relink-asyncify.sh in the lean-wasm-build
# container. Probes whether -sASYNCIFY=1 links cleanly with our stage1
# build state. Output (lean-asyncify.{js,wasm}) lands in
# build-wasm/stage1/bin/ on host (via the volume mount).
#
# This does NOT clobber existing binaries. Failure modes are diagnostic.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LEAN_SRC=$ROOT/vendor/lean4-src
BUILD_DIR=$ROOT/build-wasm
CCACHE_DIR=$ROOT/.ccache
IMAGE=lean-wasm-build

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[host] Docker image $IMAGE not found. Build it via scripts/docker-build.sh first." >&2
  exit 2
fi

mkdir -p "$BUILD_DIR" "$CCACHE_DIR"

echo "[host] starting Asyncify relink in container..."
exec docker run --rm \
  -v "$LEAN_SRC":/work/lean4 \
  -v "$BUILD_DIR":/work/build \
  -v "$CCACHE_DIR":/cache/ccache \
  -v "$ROOT/docker":/work/scripts:ro \
  "$IMAGE" \
  bash /work/scripts/relink-asyncify.sh
