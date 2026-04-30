#!/usr/bin/env node
// Try various imports to isolate which fails.
const { spawnSync } = require('child_process');

function run(label, source, args, timeout = 60000) {
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
    console.log('RESULT=' + JSON.stringify({ exit, stdout: stdoutBuf.slice(0, 400), stderr: stderrBuf.slice(0, 400) }));
  };
  wait();
})();
`;
  const r = spawnSync('node', ['--max-old-space-size=10240', '-e', driver], {
    encoding: 'utf8', timeout, maxBuffer: 50_000_000,
  });
  const m = (r.stdout || '').match(/^RESULT=(.+)$/m);
  if (m) return { label, ...JSON.parse(m[1]) };
  return { label, status: 'crash', stderr: (r.stderr||'').slice(0,300) };
}

const cases = [
  { label: 'prelude only',   source: 'prelude\n' },
  { label: 'prelude + def',  source: 'prelude\ndef x := 0\n' },
  { label: 'no prelude (implicit Init)', source: 'def x := 0\n' },
  { label: 'import Init.Prelude', source: 'prelude\nimport Init.Prelude\n' },
  { label: 'import Init',     source: 'import Init\n' },
];

for (const c of cases) {
  const r = run(c.label, c.source, ['--json', '--root=/work', '/work/Input.lean']);
  console.log('=== ' + c.label + ' ===');
  console.log('  exit=' + r.exit);
  if (r.stdout) console.log('  stdout: ' + JSON.stringify(r.stdout));
  if (r.stderr) console.log('  stderr: ' + JSON.stringify(r.stderr));
}
