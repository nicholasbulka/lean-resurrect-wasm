#!/usr/bin/env node
const { spawnSync } = require('child_process');
const LEAN_ROOT = '/tmp/leanroot';

function run(label, source, args, timeout = 12000) {
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
      const source = ${JSON.stringify(source)};
      if (source !== null) FS.writeFile('/work/Input.lean', new TextEncoder().encode(source));
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
    console.log('RESULT=' + JSON.stringify({ exit, ms: Date.now()-t0, stdout: stdoutBuf, stderr: stderrBuf }));
  };
  wait();
})();
`;
  const r = spawnSync('node', ['--max-old-space-size=10240', '-e', driver], {
    encoding: 'utf8', timeout, maxBuffer: 50_000_000,
  });
  const m = (r.stdout || '').match(/^RESULT=(.+)$/m);
  if (m) {
    const p = JSON.parse(m[1]);
    return { label, status: 'ok', ...p };
  }
  if (r.signal === 'SIGTERM') return { label, status: 'TIMEOUT' };
  return { label, status: 'crash', stdout: r.stdout, stderr: r.stderr };
}

const cases = [
  // Empty file with --json: hangs (baseline)
  { label: '--json empty',          source: '',                  args: ['--json', '--root=/work', '/work/Input.lean'] },
  // No --json, just file:
  { label: 'no --json',              source: '',                  args: ['--root=/work', '/work/Input.lean'] },
  // --threads=0:
  { label: '--threads=0',            source: '',                  args: ['-j0', '--json', '--root=/work', '/work/Input.lean'] },
  // -DElab.async=false:
  { label: 'Elab.async=false',       source: '',                  args: ['-D', 'Elab.async=false', '--json', '--root=/work', '/work/Input.lean'] },
  // --o=output.olean (bypass json, write olean):
  { label: '--o=output',             source: '',                  args: ['--o=/tmp/out.olean', '--root=/work', '/work/Input.lean'] },
  // print imports only (already known: works for --deps):
  { label: '--deps --src-deps',      source: '',                  args: ['--deps', '--src-deps', '--root=/work', '/work/Input.lean'] },
  // import nothing, eval simple:
  { label: '#eval simple',           source: '#eval 0\n',         args: ['--json', '--root=/work', '/work/Input.lean'] },
];

(async () => {
  for (const c of cases) {
    process.stdout.write(`=== ${c.label} ===\n  args=${JSON.stringify(c.args)}\n`);
    const r = run(c.label, c.source, c.args);
    if (r.status === 'ok') {
      const stdout = (r.stdout || '').slice(0, 200);
      const stderr = (r.stderr || '').slice(0, 200);
      console.log(`  ok exit=${r.exit} ms=${r.ms} stdout=${(r.stdout||'').length}B stderr=${(r.stderr||'').length}B`);
      if (stdout) console.log(`  stdout: ${JSON.stringify(stdout)}`);
      if (stderr) console.log(`  stderr: ${JSON.stringify(stderr)}`);
    } else {
      console.log(`  ${r.status}`);
    }
  }
})();
