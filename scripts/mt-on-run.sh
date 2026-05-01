#!/usr/bin/env bash
# Run an arbitrary Lean file through MT=ON WASM Lean.
# Usage: scripts/mt-on-run.sh <path-to-source.lean> [--root <dir>]
#
# Copies the source into /tmp/leanroot/work (so the worker's NODEFS mount
# sees it) and runs lean --json. Prints diagnostics to stderr and exits with
# Lean's exit code.
set -uo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <source.lean> [--root <pkg-root-dir>]" >&2
  exit 2
fi

SRC=$1
shift
ROOT_OVERRIDE=""
if [ "${1:-}" = "--root" ]; then
  ROOT_OVERRIDE=$2
fi

if [ ! -f "$SRC" ]; then
  echo "[mt-on-run] no such file: $SRC" >&2
  exit 2
fi

LEAN_ROOT=${LEAN_ROOT:-/tmp/leanroot}
mkdir -p "$LEAN_ROOT/work"
DEST="$LEAN_ROOT/work/$(basename "$SRC")"
cp "$SRC" "$DEST"

NODE_OPTIONS="--max-old-space-size=10240" \
SRC_PATH="$DEST" \
ROOT_OVERRIDE="$ROOT_OVERRIDE" \
LEAN_ROOT="$LEAN_ROOT" \
node -e '
(() => {
const LEAN_ROOT = process.env.LEAN_ROOT;
const SRC_PATH = process.env.SRC_PATH;
const ROOT_OVERRIDE = process.env.ROOT_OVERRIDE;
let done = false;
global.Module = {
  noInitialRun: true,
  onExit: (status) => {
    console.log("[onExit] status=" + status);
    done = true;
    process.exit(status);
  },
  onAbort: (what) => { console.error("[onAbort]", what); process.exit(3); },
};
require(LEAN_ROOT + "/bin/lean.js");
const wait = () => {
  if (!global.Module.calledRun) { setTimeout(wait, 100); return; }
  console.log("[harness] running compile...");
  try {
    const fs = require("fs");
    const root = ROOT_OVERRIDE || (fs.realpathSync(LEAN_ROOT) + "/work");
    const src = fs.realpathSync(SRC_PATH);
    const args = ["--json", "-R", root, src];
    console.log("[harness] callMain args:", JSON.stringify(args));
    global.Module.callMain(args);
  } catch(e) { console.log("[callMain THREW]", e && (e.message || e)); process.exit(4); }
};
wait();
setTimeout(() => {
  if (!done) {
    console.log("[timeout] 600s elapsed, killing");
    process.exit(2);
  }
}, 600_000);
})();
'
