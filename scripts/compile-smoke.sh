#!/usr/bin/env bash
# Real-compile smoke. Stages a Lean source file, runs `lean --json
# /work/Input.lean`, captures diagnostics. Compares against expected
# behavior for several test cases. Each case runs a fresh Node process
# because Lean's runtime exits on completion.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LEAN_ROOT=${LEAN_ROOT:-/tmp/leanroot}

run_one() {
  local label=$1
  local source=$2
  local args=$3
  NODE_OPTIONS="--max-old-space-size=10240" \
  node -e "
  (() => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const LEAN_ROOT = '$LEAN_ROOT';
  const LEAN_JS   = LEAN_ROOT + '/bin/lean.js';
  let src = fs.readFileSync(LEAN_JS, 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module[\"callMain\"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\d+):\(\)=>\{if\(typeof process===.undefined.\|\|process\.release\.name!==.node.\)\{throw new Error\(.The Lean command-line driver[\\s\\S]*?FS\.chdir\(process\.cwd\(\)\)\}/, '\$1:()=>{}');
  global.__filename = '/leanroot/bin/lean.js';
  global.__dirname = '/leanroot/bin';
  let stdoutBuf = '', stderrBuf = '';
  global.Module = {
    noInitialRun: true,
    noExitRuntime: false,
    thisProgram: LEAN_JS,
    print: (...a) => { stdoutBuf += a.join(' ') + '\n'; },
    printErr: (...a) => { stderrBuf += a.join(' ') + '\n'; },
    locateFile: (p) => path.join(LEAN_ROOT + '/bin', p),
    preRun: [function () {
      const FS = global.Module.FS;
      const NODEFS = global.Module.NODEFS;
      try { FS.mkdirTree('/leanroot'); } catch(_){}
      FS.mount(NODEFS, { root: LEAN_ROOT }, '/leanroot');
      try { FS.mkdirTree('/work'); } catch(_){}
      FS.writeFile('/work/Input.lean', new TextEncoder().encode(${source@Q}));
    }],
    onAbort: (what) => { console.error('[onAbort]', what); process.exit(3); },
  };
  vm.runInThisContext(src, { filename: LEAN_JS });
  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 100); return; }
    const t0 = Date.now();
    let exit = -1;
    try {
      const ret = global.Module.callMain($args);
      exit = (typeof ret === 'number') ? ret : -2;
    } catch (e) {
      exit = (e && e.status !== undefined) ? e.status : 'THREW: ' + (e?.message || e);
    }
    const dt = Date.now() - t0;
    console.log('TEST=' + ${label@Q} + ' exit=' + exit + ' ms=' + dt
      + ' stdout=' + stdoutBuf.length + 'B stderr=' + stderrBuf.length + 'B');
    if (stdoutBuf) console.log('STDOUT: ' + JSON.stringify(stdoutBuf.slice(0, 600)));
    if (stderrBuf) console.log('STDERR: ' + JSON.stringify(stderrBuf.slice(0, 600)));
  };
  wait();
  })();
  " 2>&1
}

echo === Test 1: trivial Lean source
run_one "trivial" $'#eval 1 + 1\n' '["--json","--root=/work","/work/Input.lean"]'

echo === Test 2: type error
run_one "type_error" $'def x : Nat := "hello"\n' '["--json","--root=/work","/work/Input.lean"]'

echo === Test 3: import Init
run_one "import_init" $'import Init\n#eval (1 + 2 : Nat)\n' '["--json","--root=/work","/work/Input.lean"]'

echo === Test 4: --help
run_one "help" "" '["--help"]'

echo === Test 5: --print-libdir
run_one "print_libdir" "" '["--print-libdir"]'
