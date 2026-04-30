#!/usr/bin/env node
// Test if adding `module` keyword bypasses the per-module IR requirement.
const { spawnSync } = require('child_process');

function run(label, source, args, timeout = 12000) {
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
      FS.writeFile('/work/Input.lean', new TextEncoder().encode(${JSON.stringify(source)}));
    }],
  };
  vm.runInThisContext(src);
  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
    let exit = -1;
    try { const ret = global.Module.callMain(${JSON.stringify(args)}); exit = (typeof ret === 'number') ? ret : -2; }
    catch (e) { exit = (e && e.status !== undefined) ? e.status : 'THREW:' + (e && e.message || e); }
    console.log('RESULT=' + JSON.stringify({ exit, stdout: stdoutBuf.slice(0, 600), stderr: stderrBuf.slice(0, 200) }));
  };
  wait();
})();
`;
  const r = spawnSync('node', ['--max-old-space-size=10240', '-e', driver], {
    encoding: 'utf8', timeout, maxBuffer: 50_000_000,
  });
  const m = (r.stdout || '').match(/^RESULT=(.+)$/m);
  return m ? { label, ...JSON.parse(m[1]) } : { label, status: 'crash' };
}

const cases = [
  { label: 'plain def',                    source: 'def x : Nat := 42\n' },
  { label: 'module + def',                 source: 'module\ndef x : Nat := 42\n' },
  { label: 'module + public + def',        source: 'module\npublic def x : Nat := 42\n' },
];

for (const c of cases) {
  console.log('=== ' + c.label + ' ===');
  const r = run(c.label, c.source, ['--json', '--root=/work', '/work/Input.lean']);
  console.log('  exit=' + r.exit);
  if (r.stdout) console.log('  stdout:', JSON.stringify(r.stdout));
}
