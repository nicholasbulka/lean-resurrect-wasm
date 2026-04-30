#!/usr/bin/env node
// Tighter bisection on the -j flag: -j0 didn't hang in probe-hang2,
// but default did. With MT=OFF, defaultNumThreads should also be 0.
// So either (a) the difference is real (hang depends on something other
// than numThreads itself but on the option-parser side-effect) or
// (b) probe2 was lucky. Re-test with multiple repeats.

const { spawnSync } = require('child_process');
const LEAN_ROOT = '/tmp/leanroot';

function run(label, args, timeout = 10000, env = {}) {
  const driver = `
(() => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  let src = fs.readFileSync('${LEAN_ROOT}/bin/lean.js', 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\\d+):\\(\\)=>\\{if\\(typeof process==="undefined"\\|\\|process\\.release\\.name!=="node"\\)\\{throw new Error\\("The Lean command-line driver[\\s\\S]*?FS\\.chdir\\(process\\.cwd\\(\\)\\)\\}/, '$1:()=>{}');
  global.__filename = '/leanroot/bin/lean.js';
  global.__dirname = '/leanroot/bin';
  let stdoutBuf = '', stderrBuf = '';
  global.Module = {
    noInitialRun: true, noExitRuntime: false, thisProgram: '${LEAN_ROOT}/bin/lean.js',
    print: (...a) => { stdoutBuf += a.join(' ') + '\\n'; },
    printErr: (...a) => { stderrBuf += a.join(' ') + '\\n'; },
    locateFile: (p) => path.join('${LEAN_ROOT}/bin', p),
    preRun: [function () {
      const FS = global.Module.FS, NODEFS = global.Module.NODEFS;
      try { FS.mkdirTree('/leanroot'); } catch(_){}
      FS.mount(NODEFS, { root: '${LEAN_ROOT}' }, '/leanroot');
      try { FS.mkdirTree('/work'); } catch(_){}
      FS.writeFile('/work/Input.lean', new TextEncoder().encode(''));
    }],
    onAbort: (what) => { console.log('ABORT=' + what); process.exit(3); },
  };
  vm.runInThisContext(src);
  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
    const t0 = Date.now();
    let exit = -1;
    try { const ret = global.Module.callMain(${JSON.stringify(args)}); exit = (typeof ret === 'number') ? ret : -2; }
    catch (e) { exit = (e && e.status !== undefined) ? e.status : 'THREW:' + (e && e.message || e); }
    console.log('RESULT=' + JSON.stringify({ exit, ms: Date.now()-t0, stdout: stdoutBuf.slice(0, 240), stderr: stderrBuf.slice(0, 240) }));
  };
  wait();
})();
`;
  const r = spawnSync('node', ['--max-old-space-size=10240', '-e', driver], {
    encoding: 'utf8', timeout, maxBuffer: 50_000_000,
    env: { ...process.env, ...env },
  });
  const m = (r.stdout || '').match(/^RESULT=(.+)$/m);
  if (m) return { label, status: 'ok', ...JSON.parse(m[1]) };
  if (r.signal === 'SIGTERM') return { label, status: 'TIMEOUT' };
  return { label, status: 'crash', stdout: (r.stdout||'').slice(0,300), stderr: (r.stderr||'').slice(0,300) };
}

// Each takes empty Input.lean.
const cases = [
  { label: 'default (no -j)',     args: ['--json', '--root=/work', '/work/Input.lean'] },
  { label: '-j0',                 args: ['-j0', '--json', '--root=/work', '/work/Input.lean'] },
  { label: '-j 0 (separate)',     args: ['-j', '0', '--json', '--root=/work', '/work/Input.lean'] },
  { label: '-j1',                 args: ['-j1', '--json', '--root=/work', '/work/Input.lean'] },
  { label: '-j2',                 args: ['-j2', '--json', '--root=/work', '/work/Input.lean'] },
  { label: '--threads=0',         args: ['--threads=0', '--json', '--root=/work', '/work/Input.lean'] },
  { label: '--threads=1',         args: ['--threads=1', '--json', '--root=/work', '/work/Input.lean'] },
  // env vs flag:
  { label: 'env LEAN_NUM_THREADS=0', args: ['--json', '--root=/work', '/work/Input.lean'], env: { LEAN_NUM_THREADS: '0' } },
  { label: 'env LEAN_NUM_THREADS=1', args: ['--json', '--root=/work', '/work/Input.lean'], env: { LEAN_NUM_THREADS: '1' } },
  // repeats of -j0 to confirm reproducibility:
  { label: '-j0 (repeat)',        args: ['-j0', '--json', '--root=/work', '/work/Input.lean'] },
  { label: 'default (repeat)',    args: ['--json', '--root=/work', '/work/Input.lean'] },
];

(async () => {
  for (const c of cases) {
    process.stdout.write(`=== ${c.label} ===\n`);
    const r = run(c.label, c.args, 10000, c.env || {});
    if (r.status === 'ok') {
      console.log(`  ok exit=${r.exit} ms=${r.ms}`);
      if (r.stdout) console.log(`  stdout: ${JSON.stringify(r.stdout)}`);
      if (r.stderr) console.log(`  stderr: ${JSON.stringify(r.stderr)}`);
    } else {
      console.log(`  ${r.status}`);
    }
  }
})();
