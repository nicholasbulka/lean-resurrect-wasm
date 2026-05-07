#!/usr/bin/env bash
# Host-side wrapper: run the wasm-deps build inside Docker so it's
# reproducible across machines.
#
# Usage:
#   scripts/build-wasm-deps.sh <library-key> [flags]
#
# Flags (forwarded to the container):
#   --allow-nonhash-rev      accept refs that aren't 40-char hex
#   --allow-date-violation   accept Mathlib commit > 90 days from Lean release
#   --strict                 turn validator warnings into errors
#   --force-rebuild          wipe scratch + bundle before building
#   --dry-run                clone + validate but skip the build step
#   --image=<tag>            container image tag (default: lean-wasm-build:v4.27.0)
#   --build-image            build the image first if it doesn't exist
#
# Outputs:
#   cdn/projects/<slug>/oleans.bundle             bundle (when build succeeds)
#   cdn/projects/<slug>/build-logs/<id>/          per-build trace dir
#     build-manifest.json                         full reproducibility record
#     build.log                                   raw stdout
#     events.jsonl                                structured event stream
#     deps.jsonl                                  one record per dep clone
#     validation-report.json                      validator output

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <library-key> [--allow-nonhash-rev] [--allow-date-violation] [--strict] [--force-rebuild] [--dry-run] [--image=<tag>] [--build-image]" >&2
  echo >&2
  echo "available libraries:" >&2
  jq -r '.libraries | keys[] | "  - " + .' config/wasm-deps.json >&2 || true
  exit 2
fi

LIB_KEY="$1"; shift
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="lean-wasm-build:v4.27.0"
BUILD_IMAGE=0
ENV_FLAGS=()

for arg in "$@"; do
  case "$arg" in
    --allow-nonhash-rev)    ENV_FLAGS+=("-e" "ALLOW_NONHASH_REV=1") ;;
    --allow-date-violation) ENV_FLAGS+=("-e" "ALLOW_DATE_VIOLATION=1") ;;
    --strict)               ENV_FLAGS+=("-e" "STRICT=1") ;;
    --force-rebuild)        ENV_FLAGS+=("-e" "FORCE_REBUILD=1") ;;
    --dry-run)              ENV_FLAGS+=("-e" "DRY_RUN=1") ;;
    --build-image)          BUILD_IMAGE=1 ;;
    --image=*)              IMAGE="${arg#--image=}" ;;
    *)                      echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

if [ "$BUILD_IMAGE" = "1" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[wrapper] building image $IMAGE"
  docker build -f docker/Dockerfile.build-wasm-deps -t "$IMAGE" .
fi

mkdir -p .build-cache cdn/projects

echo "[wrapper] running $IMAGE for library=$LIB_KEY"
docker run --rm \
  -v "$ROOT/cdn:/out" \
  -v "$ROOT/.build-cache:/cache" \
  -v "$ROOT/config:/config:ro" \
  -v "$ROOT/preflight:/preflight:ro" \
  -v "$ROOT/vendor/lean-linux_wasm32:/wasm-lean" \
  -e LIBRARY_KEY="$LIB_KEY" \
  "${ENV_FLAGS[@]}" \
  "$IMAGE"
