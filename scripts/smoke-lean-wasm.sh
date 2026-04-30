#!/usr/bin/env bash
# Fail-fast smoke test: load build-wasm/stage1/bin/lean.{js,wasm} in Node
# and run `--version`. If the binary traps with `unreachable` or hangs,
# we find out in seconds instead of after a 30s Playwright cycle (or
# worse, after a full IDE rebuild + browser test).
#
# Usage:
#   scripts/smoke-lean-wasm.sh                 # use build-wasm/stage1/bin/
#   scripts/smoke-lean-wasm.sh path/to/dir     # use a different build output
#
# Exit 0 = clean version printed.
# Exit 1 = trap, hang, or unexpected output.

set -uo pipefail

SRC=${1:-$(cd "$(dirname "$0")/.." && pwd)/build-wasm/stage1/bin}
LEAN_JS=$SRC/lean.js
LEAN_WASM=$SRC/lean.wasm

if [ ! -f "$LEAN_JS" ] || [ ! -f "$LEAN_WASM" ]; then
  echo "[smoke] missing $LEAN_JS or $LEAN_WASM" >&2
  exit 2
fi

echo "[smoke] testing $SRC"
echo "[smoke]   lean.js   $(stat -f%z "$LEAN_JS" 2>/dev/null || stat -c%s "$LEAN_JS") bytes"
echo "[smoke]   lean.wasm $(stat -f%z "$LEAN_WASM" 2>/dev/null || stat -c%s "$LEAN_WASM") bytes"

# Node harness: load lean.js with our standard shims, fire callMain(['--version']).
# 30 s hard timeout — if main hasn't returned by then, it's hung or trapped
# without surfacing a JS error.
TIMEOUT_SEC=30
NODE_OPTIONS="--max-old-space-size=10240" \
node --experimental-vm-modules -e "
// Wrap in IIFE so our local \`const fs\`, \`const path\` etc. don't collide
// with lean.js's top-level \`var fs\`, \`var path\` declarations when we run
// it via vm.runInThisContext.
(() => {
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LEAN_JS = '$LEAN_JS';
const LEAN_WASM_DIR = '$SRC';

// Lean's IO.appDir reads __filename to compute install prefix. Node's
// vm.runInThisContext sets __filename to '[eval]' which Lean rejects.
// Override before lean.js loads.
global.__filename = LEAN_JS;
global.__dirname = LEAN_WASM_DIR;

// Patch lean.js: expose Module.callMain + strip Node-check EM_ASM (which
// in Node we'd technically pass, but the FS.mount NODEFS calls in there
// also blow up; safer to short-circuit).
let src = fs.readFileSync(LEAN_JS, 'utf8');
const PATCH_V427_OLD = 'function callMain(args=[]){';
const PATCH_V427_NEW = 'Module[\"callMain\"]=callMain;function callMain(args=[]){';
if (src.includes(PATCH_V427_OLD)) {
  src = src.replace(PATCH_V427_OLD, PATCH_V427_NEW);
  console.log('[smoke] patched callMain export');
}
src = src.replace(
  /(\d+):\(\)=>\{if\(typeof process===.undefined.\|\|process\.release\.name!==.node.\)\{throw new Error\(.The Lean command-line driver[\\s\\S]*?FS\.chdir\(process\.cwd\(\)\)\}/,
  '\$1:()=>{/* CLI Node-check stripped */}'
);

let exitCode = -1;
let stdoutBuf = '', stderrBuf = '';
// Don't declare \`const Module\` — lean.js does \`var Module = typeof Module
// != \"undefined\" ? Module : {}\` and a local lexical binding collides.
// Assign via global so lean.js's \`var\` declaration picks up our config.
global.Module = {
  arguments: [],
  thisProgram: '/lean',
  noInitialRun: true,
  noExitRuntime: true,
  print: (...a) => { const s = a.join(' '); stdoutBuf += s + '\\n'; console.log('[lean.stdout]', s); },
  printErr: (...a) => { const s = a.join(' '); stderrBuf += s + '\\n'; console.log('[lean.stderr]', s); },
  locateFile: (p) => path.join(LEAN_WASM_DIR, p),
  onAbort: (what) => { console.error('[smoke] onAbort:', what); process.exit(3); },
  preRun: [function () {
    const M = global.Module;
    M.FS.mkdirTree('/work');
    M.FS.mkdirTree('/home/user');
    M.FS.mkdirTree('/lib/lean');
    M.ENV = M.ENV || {};
    M.ENV.LEAN_PATH = '/lib/lean';
    M.ENV.HOME = '/home/user';
  }],
};

// Run lean.js inline in Node's main realm (it's a CommonJS-style module
// that mutates global Module). vm.runInThisContext keeps it in the same
// realm so global.Module is shared.
vm.runInThisContext(src, { filename: LEAN_JS });

const t0 = Date.now();
const timeout = setTimeout(() => {
  console.error('[smoke] HANG: callMain has not returned after ' + ${TIMEOUT_SEC} + 's');
  process.exit(4);
}, ${TIMEOUT_SEC} * 1000);

const wait = () => {
  if (Module.calledRun) {
    console.log('[smoke] calledRun=true after ' + (Date.now() - t0) + 'ms');
    if (typeof Module.callMain !== 'function') {
      console.error('[smoke] Module.callMain not available after init');
      clearTimeout(timeout);
      process.exit(5);
    }
    try {
      exitCode = Module.callMain(['--version']) ?? 0;
      console.log('[smoke] --version exit=' + exitCode + ' ms=' + (Date.now() - t0));
      clearTimeout(timeout);
      if (/Lean \\(version/.test(stdoutBuf)) {
        console.log('[smoke] PASS: version banner found');
        process.exit(0);
      } else {
        console.error('[smoke] FAIL: no version banner in stdout');
        process.exit(6);
      }
    } catch (e) {
      console.error('[smoke] callMain threw:', e?.message || e);
      console.error('[smoke] stack:', e?.stack || '(no stack)');
      console.error('[smoke] stdout-so-far:', JSON.stringify(stdoutBuf.slice(0, 400)));
      console.error('[smoke] stderr-so-far:', JSON.stringify(stderrBuf.slice(0, 400)));
      clearTimeout(timeout);
      process.exit(7);
    }
  } else {
    setTimeout(wait, 100);
  }
};
wait();
})();
"
echo "[smoke] node exit code: $?"
