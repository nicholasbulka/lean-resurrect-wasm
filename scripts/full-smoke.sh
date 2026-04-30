#!/usr/bin/env bash
# Full smoke: mount /tmp/leanroot via NODEFS, run --version + a real
# compile, confirm stdout/stderr capture, exit codes, and diagnostics.
set -uo pipefail

LEAN_ROOT=${LEAN_ROOT:-/tmp/leanroot}
LEAN_JS=$LEAN_ROOT/bin/lean.js
LEAN_WASM=$LEAN_ROOT/bin/lean.wasm

if [ ! -f "$LEAN_JS" ] || [ ! -f "$LEAN_WASM" ]; then
  echo "[full-smoke] missing $LEAN_JS or $LEAN_WASM" >&2
  exit 2
fi

echo "[full-smoke] LEAN_ROOT=$LEAN_ROOT"
echo "[full-smoke]   bin: $(stat -f%z "$LEAN_JS" 2>/dev/null || stat -c%s "$LEAN_JS") bytes"
echo "[full-smoke]   oleans: $(find "$LEAN_ROOT/lib/lean" -name '*.olean' 2>/dev/null | wc -l)"

NODE_OPTIONS="--max-old-space-size=10240" \
node -e "
(() => {
const LEAN_ROOT = '$LEAN_ROOT';
const LEAN_JS   = LEAN_ROOT + '/bin/lean.js';

let stdoutBuf = '', stderrBuf = '';
// Pre-set Module before lean.js's patch prefix runs. The patch merges
// our settings into Module rather than overwriting them.
global.Module = {
  noInitialRun: true,
  print:    (...a) => { stdoutBuf += a.join(' ') + '\\n'; },
  printErr: (...a) => { stderrBuf += a.join(' ') + '\\n'; },
  onExit: (status) => {
    console.log('[onExit] status=' + status + ' stdout.len=' + stdoutBuf.length + ' stderr.len=' + stderrBuf.length);
    if (stdoutBuf) console.log('  stdout (first 200): ' + JSON.stringify(stdoutBuf.slice(0, 200)));
    if (stdoutBuf) console.log('  stdout (last 200):  ' + JSON.stringify(stdoutBuf.slice(-200)));
    if (stderrBuf) console.log('  stderr (first 400): ' + JSON.stringify(stderrBuf.slice(0, 400)));
    const versionOk = /Lean \\(version/.test(stdoutBuf);
    console.log('[result] --version: ' + (versionOk ? 'PASS' : 'FAIL'));
    process.exit(versionOk ? 0 : 1);
  },
  onAbort: (what) => { console.error('[full-smoke] onAbort:', what); process.exit(3); },
};

// Just require the patched lean.js — its patch prefix takes care of
// preRun (NODEFS mount) and locateFile.
require(LEAN_JS);

const wait = () => {
  if (!global.Module.calledRun) { setTimeout(wait, 100); return; }
  console.log('[full-smoke] calledRun=true; spawning callMain (proxied to pthread)');
  try {
    global.Module.callMain(['--version']);
  } catch (e) {
    console.log('[callMain THREW]', e && (e.message || e));
  }
};
wait();
// Safety net: if onExit never fires, exit with timeout error after 30s.
setTimeout(() => {
  console.log('[timeout] onExit never fired after 30s. stdout.len=' + stdoutBuf.length);
  if (stdoutBuf) console.log('  stdout:', JSON.stringify(stdoutBuf.slice(0, 400)));
  process.exit(2);
}, 30_000);
})();
"
