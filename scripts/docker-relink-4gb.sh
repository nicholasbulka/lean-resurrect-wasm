#!/usr/bin/env bash
# Host-side wrapper: run docker/relink-4gb.sh in the lean-wasm-build
# container. Same mount pattern as the other docker-relink-*.sh scripts.
# Output: build-wasm/stage1/bin/lean.{js,wasm,worker.js}.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LEAN_SRC=$ROOT/vendor/lean4-src
BUILD_DIR=$ROOT/build-wasm
CCACHE_DIR=$ROOT/.ccache
IMAGE=lean-wasm-build

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[host] Docker image $IMAGE not found." >&2
  exit 2
fi

mkdir -p "$BUILD_DIR" "$CCACHE_DIR"

echo "[host] starting 4GB-cap relink in container..."
exec docker run --rm \
  -v "$LEAN_SRC":/work/lean4 \
  -v "$BUILD_DIR":/work/build \
  -v "$CCACHE_DIR":/cache/ccache \
  -v "$ROOT/docker":/work/scripts:ro \
  "$IMAGE" \
  bash /work/scripts/relink-4gb.sh
