#!/usr/bin/env bash
# Copy freshly-built WASM artifacts from build-wasm/ over the vendored v4.15
# release binary so the browser harness picks them up.
#
# Destructive (overwrites vendor/lean-linux_wasm32/bin/lean.{js,wasm,worker.js}).
# Backups go to vendor/lean-linux_wasm32/bin/*.v4.15 the first time.

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VENDOR_BIN=$ROOT/vendor/lean-linux_wasm32/bin
BUILD=$ROOT/build-wasm

# Artifacts from Lean's build land in stage1/shell/ under the build dir.
# Fall back to searching if the layout differs.
CANDIDATES=(
  "$BUILD/stage1/shell"
  "$BUILD/shell"
  "$BUILD/stage1/bin"
)

SRC=""
for c in "${CANDIDATES[@]}"; do
  if [ -f "$c/lean.wasm" ]; then SRC=$c; break; fi
done
if [ -z "$SRC" ]; then
  echo "[swap] no lean.wasm found; searching..." >&2
  SRC=$(dirname "$(find "$BUILD" -name 'lean.wasm' -type f | head -1)") || true
fi
if [ -z "$SRC" ] || [ ! -f "$SRC/lean.wasm" ]; then
  echo "[swap] no built lean.wasm found under $BUILD" >&2
  exit 2
fi

echo "[swap] source:      $SRC"
echo "[swap] destination: $VENDOR_BIN"

for f in lean.js lean.wasm lean.worker.js; do
  if [ -f "$VENDOR_BIN/$f" ] && [ ! -f "$VENDOR_BIN/$f.v4.15" ]; then
    cp "$VENDOR_BIN/$f" "$VENDOR_BIN/$f.v4.15"
    echo "[swap] backed up $f -> $f.v4.15"
  fi
done

for f in lean.js lean.wasm lean.worker.js; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$VENDOR_BIN/$f"
    echo "[swap] copied $f ($(stat -f%z "$SRC/$f" 2>/dev/null || stat -c%s "$SRC/$f") bytes)"
  fi
done

echo "[swap] done. Reload the browser harness to pick up the new binary."
echo "[swap] To revert: cp $VENDOR_BIN/lean.js.v4.15 $VENDOR_BIN/lean.js   (same for .wasm, .worker.js)"
