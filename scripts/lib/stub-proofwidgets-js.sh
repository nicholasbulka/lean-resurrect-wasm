#!/usr/bin/env bash
# Stub the JS files ProofWidgets's library modules `include_str!` at compile
# time. ProofWidgets ships React/D3-based interactive widgets whose JS comes
# from a separate npm build step (`lake build` → `npm run build`); we don't
# run npm in this pipeline. The widgets are runtime artifacts (rendered in
# VS Code's panel), so empty stubs are fine for our wasm32 build path —
# Lean's elaboration succeeds, the resulting oleans contain empty JS where
# real widgets would sit, and the IDE doesn't render them anyway.
#
# Usage: scripts/lib/stub-proofwidgets-js.sh <proofwidgets-repo-root>
#
# Idempotent: re-running on a populated stub dir is a no-op.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <proofwidgets-repo-root>" >&2
  exit 2
fi

PW_ROOT="$1"
if [ ! -d "$PW_ROOT/ProofWidgets" ]; then
  echo "[stub-pw] $PW_ROOT/ProofWidgets not found" >&2
  exit 2
fi

JSDIR="$PW_ROOT/.lake/build/js"
mkdir -p "$JSDIR"

# Find every JS filename ProofWidgets sources `include_str` and create a
# stub for each. Lean's include_str just reads bytes; an empty file
# satisfies the call.
JS_FILES=$(grep -rohE '"[^"]+\.js"' "$PW_ROOT/ProofWidgets/" 2>/dev/null \
  | tr -d '"' | sort -u)

if [ -z "$JS_FILES" ]; then
  echo "[stub-pw] no include_str references found — ProofWidgets layout may have changed"
  exit 0
fi

count=0
while read -r js; do
  if [ -z "$js" ]; then continue; fi
  if [ ! -f "$JSDIR/$js" ]; then
    echo "// stub — wasm32 cross-compile path doesn't run npm" > "$JSDIR/$js"
    count=$((count + 1))
  fi
done <<< "$JS_FILES"

echo "[stub-pw] $count JS stubs ensured at $JSDIR"
