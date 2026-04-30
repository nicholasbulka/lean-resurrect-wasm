#!/usr/bin/env node
const { spawnSync } = require('child_process');
const driver = `
(() => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const LEAN_ROOT = '/tmp/leanroot';
  let src = fs.readFileSync(LEAN_ROOT + '/bin/lean.js', 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\\d+):\\(\\)=>\\{if\\(typeof process==="undefined"\\|\\|process\\.release\\.name!=="node"\\)\\{throw new Error\\("The Lean command-line driver[\\s\\S]*?FS\\.chdir\\(process\\.cwd\\(\\)\\)\\}/, '$1:()=>{}');
  global.__filename = '/leanroot/bin/lean.js';
  global.__dirname = '/leanroot/bin';
  let stdoutBuf = '', stderrBuf = '';
  global.Module = {
    noInitialRun: true, noExitRuntime: false, thisProgram: LEAN_ROOT + '/bin/lean.js',
    print: (...a) => { stdoutBuf += a.join(' ') + '\\n'; },
    printErr: (...a) => { stderrBuf += a.join(' ') + '\\n'; },
    locateFile: (p) => path.join(LEAN_ROOT + '/bin', p),
    preRun: [function () {
      const FS = global.Module.FS, NODEFS = global.Module.NODEFS;
      try { FS.mkdirTree('/leanroot'); } catch(_){}
      FS.mount(NODEFS, { root: LEAN_ROOT }, '/leanroot');
      try { FS.mkdirTree('/work'); } catch(_){}
      FS.writeFile('/work/Input.lean', new TextEncoder().encode('def x : Nat := 42\\n'));
    }],
  };
  vm.runInThisContext(src);
  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
    let exit = -1;
    try { const ret = global.Module.callMain(['--json', '--root=/work', '/work/Input.lean']); exit = (typeof ret === 'number') ? ret : -2; }
    catch (e) {
      exit = (e && e.status !== undefined) ? e.status : 'THREW:' + (e && e.message || e);
      stderrBuf += '=== exception stack ===\\n' + (e && e.stack || '(no stack)') + '\\n';
    }
    // Use stderr (unbuffered) and exit explicitly so the writes survive
    // even when Lean's EXIT_RUNTIME tears down on success.
    require('fs').writeFileSync('/tmp/probe-result.txt',
      '=== STDOUT ===\\n' + stdoutBuf + '=== STDERR ===\\n' + stderrBuf + '=== exit=' + exit + '\\n');
    process.exit(0);
  };
  wait();
})();
`;
const r = spawnSync('node', ['--max-old-space-size=10240', '-e', driver], {
  encoding: 'utf8', maxBuffer: 50_000_000, timeout: 900_000,
});
console.error('child status=' + r.status + ' signal=' + r.signal);
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
