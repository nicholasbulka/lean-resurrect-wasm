#!/usr/bin/env bash
# Cross-compile a pegged library set to wasm32 and pack into a CDN bundle.
#
# Usage:
#   scripts/build-wasm-deps.sh <library-key>
#
# where <library-key> is a key under `libraries` in config/wasm-deps.json
# (e.g. "mathlib-v4.27.0-2026-04", "li-criterion").
#
# This is a slow operation — Mathlib alone is hours, sometimes overnight.
# The script is idempotent: it caches at every step (clone, build, bundle)
# so re-runs after partial failure pick up where they left off.
#
# Requirements:
#   - vendor/lean-linux_wasm32/bin/lean.{js,wasm} present (wasm32 toolchain)
#   - lake binary on PATH (any v4.27.0 native lake works for orchestration)
#   - git, jq, node
#
# Output:
#   - cdn/projects/<cdnSlug>/oleans.bundle      packed wasm32 oleans
#   - cdn/projects/<cdnSlug>/sources.json       optional .lean sources for browsing
#   - .build-cache/wasm-deps/<library-key>/     scratch workspace (kept across runs)

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <library-key>" >&2
  echo "available keys:" >&2
  jq -r '.libraries | keys[] | "  - " + .' config/wasm-deps.json >&2
  exit 2
fi

LIB_KEY="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PEGS_FILE="$ROOT/config/wasm-deps.json"
SCRATCH_ROOT="$ROOT/.build-cache/wasm-deps/$LIB_KEY"
CDN_OUT_ROOT="$ROOT/cdn/projects"
WASM_LEAN_ROOT="$ROOT/vendor/lean-linux_wasm32"

if [ ! -f "$PEGS_FILE" ]; then echo "no pegs file at $PEGS_FILE" >&2; exit 1; fi
if [ ! -f "$WASM_LEAN_ROOT/bin/lean.js" ]; then
  echo "wasm32 lean missing: $WASM_LEAN_ROOT/bin/lean.js" >&2
  echo "rebuild via docker/build-wasm.sh first." >&2
  exit 1
fi

LIB_JSON=$(jq -e ".libraries[\"$LIB_KEY\"]" "$PEGS_FILE") || {
  echo "no library named '$LIB_KEY' in $PEGS_FILE" >&2
  exit 1
}

CDN_SLUG=$(echo "$LIB_JSON" | jq -r '.cdnSlug')
TOPLEVEL=$(echo "$LIB_JSON" | jq -r '.topLevel')
CDN_OUT="$CDN_OUT_ROOT/$CDN_SLUG"

echo "[build-wasm-deps] target: $LIB_KEY"
echo "[build-wasm-deps]   topLevel: $TOPLEVEL"
echo "[build-wasm-deps]   cdnSlug:  $CDN_SLUG"
echo "[build-wasm-deps]   scratch:  $SCRATCH_ROOT"
echo "[build-wasm-deps]   output:   $CDN_OUT"

# Optional: enforce dependsOn first.
DEPENDS_ON=$(echo "$LIB_JSON" | jq -r '.dependsOn // [] | .[]')
if [ -n "$DEPENDS_ON" ]; then
  for dep in $DEPENDS_ON; do
    if [ ! -f "$CDN_OUT_ROOT/$(jq -r ".libraries[\"$dep\"].cdnSlug" "$PEGS_FILE")/oleans.bundle" ]; then
      echo "[build-wasm-deps] prerequisite '$dep' not built yet — run:" >&2
      echo "  scripts/build-wasm-deps.sh $dep" >&2
      exit 1
    fi
  done
fi

mkdir -p "$SCRATCH_ROOT" "$CDN_OUT"

# Step 1: clone every dep at the pegged revision.
echo "$LIB_JSON" | jq -c '.deps[]' | while read -r dep; do
  name=$(echo "$dep" | jq -r '.name')
  url=$(echo "$dep" | jq -r '.url')
  rev=$(echo "$dep" | jq -r '.rev')
  dir="$SCRATCH_ROOT/$name"
  if [ "${url#local://}" != "$url" ]; then
    # local:// references the user's checkout; symlink rather than clone.
    src="$ROOT/../${url#local://}"
    if [ ! -d "$dir" ]; then ln -s "$src" "$dir"; fi
    echo "[$name] using local checkout: $src"
    continue
  fi
  if [ ! -d "$dir/.git" ]; then
    echo "[$name] cloning $url"
    git clone --filter=blob:none "$url" "$dir"
  fi
  cd "$dir"
  current=$(git rev-parse HEAD)
  if [ "$current" != "$rev" ]; then
    echo "[$name] checking out $rev"
    git fetch origin "$rev" 2>/dev/null || git fetch origin
    git checkout --quiet "$rev"
  else
    echo "[$name] already at $rev"
  fi
  cd "$ROOT"
done

# Step 2: build with the wasm32 toolchain.
# Each project has its own lakefile.{lean,toml}. We expect the wasm32 lean
# to be invoked via a wrapper that points lake at our preflight harness.
# This is the part that takes hours; output is per-project .lake/build/lib.
TOPLEVEL_DIR="$SCRATCH_ROOT/$TOPLEVEL"
if [ -z "$TOPLEVEL_DIR" ] || [ ! -d "$TOPLEVEL_DIR" ]; then
  echo "[build-wasm-deps] topLevel dir missing: $TOPLEVEL_DIR" >&2
  exit 1
fi

# TODO: actual lake build invocation.
#
# lake doesn't currently know how to drive a foreign-arch lean directly;
# the path forward is one of:
#   (a) Run lake under qemu-user-aarch64 with lean rebuilt to forward
#       compile invocations to our preflight/trace_fs.js harness.
#   (b) Bypass lake entirely: walk the dep order topologically and call
#       `node preflight/trace_fs.js -o <out.olean> -i <out.ilean>` for
#       each .lean file in dependency order. Slower but no host-arch
#       weirdness.
#   (c) Use the upstream lean4 build's xbuild target if/when it exists.
#
# Until one of those lands, mark the scratch workspace ready and stop:
echo "[build-wasm-deps] dependency tree resolved at $SCRATCH_ROOT"
echo "[build-wasm-deps] BUILD STEP NOT YET IMPLEMENTED — see TODO at the bottom of this script."
echo "[build-wasm-deps] To proceed manually:"
echo "  for each project under $SCRATCH_ROOT (in topological order):"
echo "    cd <proj> && find . -name '*.lean' -exec node $ROOT/preflight/trace_fs.js \\"
echo "      -o {}.olean -i {}.ilean -R . {} \\;"
echo "  then pack into a single bundle with the format:"
echo "    [u32 count][u16 pathLen][path][u32 dataLen][data]*"
echo "  and write to $CDN_OUT/oleans.bundle"
exit 0
