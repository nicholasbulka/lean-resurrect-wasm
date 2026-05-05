#!/usr/bin/env bash
# Host wrapper for docker/relink-jspi-mtoff.sh.

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if ! docker image inspect lean-wasm-build >/dev/null 2>&1; then
  echo "[host] Docker image lean-wasm-build not found." >&2
  exit 2
fi

mkdir -p "$ROOT/build-wasm" "$ROOT/.ccache"

echo "[host] starting JSPI+mtoff relink in container..."
exec docker run --rm \
  -v "$ROOT/vendor/lean4-src":/work/lean4 \
  -v "$ROOT/build-wasm":/work/build \
  -v "$ROOT/.ccache":/cache/ccache \
  -v "$ROOT/docker":/work/scripts:ro \
  lean-wasm-build \
  bash /work/scripts/relink-jspi-mtoff.sh
