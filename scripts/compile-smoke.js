#!/usr/bin/env node
// Multi-case compile smoke. Each test forks a fresh Node child running
// the WASM driver, since Lean's runtime exits after main and can't be
// re-entered.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LEAN_ROOT = process.env.LEAN_ROOT || '/tmp/leanroot';

function runOne(label, source, args) {
  const driver = `
(() => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const LEAN_ROOT = ${JSON.stringify(LEAN_ROOT)};
  const LEAN_JS = LEAN_ROOT + '/bin/lean.js';
  let src = fs.readFileSync(LEAN_JS, 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\\d+):\\(\\)=>\\{if\\(typeof process==="undefined"\\|\\|process\\.release\\.name!=="node"\\)\\{throw new Error\\("The Lean command-line driver[\\s\\S]*?FS\\.chdir\\(process\\.cwd\\(\\)\\)\\}/, '$1:()=>{}');
  global.__filename = '/leanroot/bin/lean.js';
  global.__dirname = '/leanroot/bin';
  let stdoutBuf = '', stderrBuf = '';
  global.Module = {
    noInitialRun: true,
    noExitRuntime: false,
    thisProgram: LEAN_JS,
    print: (...a) => { stdoutBuf += a.join(' ') + '\\n'; },
    printErr: (...a) => { stderrBuf += a.join(' ') + '\\n'; },
    locateFile: (p) => path.join(LEAN_ROOT + '/bin', p),
    preRun: [function () {
      const FS = global.Module.FS;
      const NODEFS = global.Module.NODEFS;
      try { FS.mkdirTree('/leanroot'); } catch(_){}
      FS.mount(NODEFS, { root: LEAN_ROOT }, '/leanroot');
      try { FS.mkdirTree('/work'); } catch(_){}
      const source = ${JSON.stringify(source)};
      if (source) FS.writeFile('/work/Input.lean', new TextEncoder().encode(source));
    }],
    onAbort: (what) => { console.error('[onAbort]', what); process.exit(3); },
  };
  vm.runInThisContext(src, { filename: LEAN_JS });
  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
    const t0 = Date.now();
    let exit = -1;
    try {
      const ret = global.Module.callMain(${JSON.stringify(args)});
      exit = (typeof ret === 'number') ? ret : -2;
    } catch (e) {
      exit = (e && e.status !== undefined) ? e.status : 'THREW:' + (e && e.message || e);
    }
    const dt = Date.now() - t0;
    console.log('RESULT=' + JSON.stringify({ exit, ms: dt, stdout: stdoutBuf, stderr: stderrBuf }));
  };
  wait();
})();
`;
  const r = spawnSync('node', ['--max-old-space-size=10240', '-e', driver], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 50 * 1024 * 1024,
  });
  const out = r.stdout || '';
  const m = out.match(/^RESULT=(.+)$/m);
  let parsed = null;
  try { parsed = m ? JSON.parse(m[1]) : null; } catch (_) {}
  return { label, parsed, stdout: out, stderr: r.stderr || '', signal: r.signal, status: r.status };
}

const tests = [
  { label: 'version',       source: '',                                args: ['--version'] },
  { label: 'help',          source: '',                                args: ['--help'] },
  { label: 'print_libdir',  source: '',                                args: ['--print-libdir'] },
  { label: 'trivial_eval',  source: '#eval 1 + 1\n',                   args: ['--json', '--root=/work', '/work/Input.lean'] },
  { label: 'simple_def',    source: 'def x : Nat := 42\n',             args: ['--json', '--root=/work', '/work/Input.lean'] },
  { label: 'type_error',    source: 'def x : Nat := "hello"\n',        args: ['--json', '--root=/work', '/work/Input.lean'] },
  { label: 'syntax_error',  source: 'def x :=\n',                      args: ['--json', '--root=/work', '/work/Input.lean'] },
];

let passed = 0;
const results = [];
for (const t of tests) {
  process.stdout.write(`\n=== ${t.label} (${JSON.stringify(t.args)}) ===\n`);
  const r = runOne(t.label, t.source, t.args);
  if (!r.parsed) {
    console.log('  driver failed:', (r.stderr || r.stdout || '').slice(0, 400));
    results.push({ ...t, ...r, ok: false });
    continue;
  }
  const { exit, ms, stdout, stderr } = r.parsed;
  console.log(`  exit=${exit} ms=${ms} stdout.len=${stdout.length} stderr.len=${stderr.length}`);
  if (stdout) console.log('  stdout:', JSON.stringify(stdout.slice(0, 300)));
  if (stderr) console.log('  stderr:', JSON.stringify(stderr.slice(0, 300)));
  results.push({ ...t, ...r.parsed, ok: true });
  passed++;
}
console.log(`\n=== summary ===`);
console.log(`${passed}/${tests.length} runs completed without driver error`);
process.exit(passed === tests.length ? 0 : 1);
