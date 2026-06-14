#!/usr/bin/env bash
# Host wrapper: full JSPI+pthread rebuild (recompiles the patched runtime,
# incl. process.cpp, then relinks). Output: lean-jspi-pt.{js,wasm}.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=lean-wasm-build
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "[host] image $IMAGE missing" >&2; exit 2; }
mkdir -p "$ROOT/build-wasm" "$ROOT/.ccache"
echo "[host] full JSPI+pthread rebuild in container (~25 min)..."
exec docker run --rm \
  -v "$ROOT/vendor/lean4-src":/work/lean4 \
  -v "$ROOT/build-wasm":/work/build \
  -v "$ROOT/.ccache":/cache/ccache \
  -v "$ROOT/docker":/work/scripts:ro \
  "$IMAGE" \
  bash /work/scripts/relink-jspi-pt.sh
