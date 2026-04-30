#!/usr/bin/env node
// Probe the elaboration hang. Each case is a fresh Node process with a
// tight 15s timeout. Goal: bisect what specifically causes the hang.

const { spawnSync } = require('child_process');
const LEAN_ROOT = process.env.LEAN_ROOT || '/tmp/leanroot';

function run(label, source, args, timeout = 15000) {
  const driver = `
(() => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const LEAN_ROOT = ${JSON.stringify(LEAN_ROOT)};
  const LEAN_JS = LEAN_ROOT + '/bin/lean.js';
  let src = fs.readFileSync(LEAN_JS, 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\\d+):\\(\\)=>\\{if\\(typeof process==="undefined"\\|\\|process\\.release\\.name!=="node"\\)\\{throw new Error\\("The Lean command-line driver[\\s\\S]*?FS\\.chdir\\(process\\.cwd\\(\\)\\)\\}/, '$1:()=>{}');
  global.__filename = '/leanroot/bin/lean.js';
  global.__dirname = '/leanroot/bin';
  let stdoutBuf = '', stderrBuf = '';
  global.Module = {
    noInitialRun: true, noExitRuntime: false, thisProgram: LEAN_JS,
    print: (...a) => { stdoutBuf += a.join(' ') + '\\n'; },
    printErr: (...a) => { stderrBuf += a.join(' ') + '\\n'; },
    locateFile: (p) => path.join(LEAN_ROOT + '/bin', p),
    preRun: [function () {
      const FS = global.Module.FS, NODEFS = global.Module.NODEFS;
      try { FS.mkdirTree('/leanroot'); } catch(_){}
      FS.mount(NODEFS, { root: LEAN_ROOT }, '/leanroot');
      try { FS.mkdirTree('/work'); } catch(_){}
      const source = ${JSON.stringify(source)};
      if (source !== null) FS.writeFile('/work/Input.lean', new TextEncoder().encode(source));
    }],
    onAbort: (what) => { console.error('ABORT:' + what); process.exit(3); },
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
    encoding: 'utf8', timeout, maxBuffer: 50_000_000,
  });
  const out = r.stdout || '';
  const m = out.match(/^RESULT=(.+)$/m);
  if (m) {
    const p = JSON.parse(m[1]);
    return { label, status: 'ok', ...p };
  }
  if (r.signal === 'SIGTERM') {
    return { label, status: 'timeout', stderr: r.stderr };
  }
  return { label, status: 'crash', stderr: r.stderr, stdout: out };
}

const cases = [
  // Sanity that metadata still works after sig fixes:
  { label: 'metadata.version',     source: null,                   args: ['--version'] },
  // No file: should error fast
  { label: 'no_file',              source: null,                   args: ['--json', '/work/Nonexistent.lean'] },
  // Empty file: parse trivial, no real elaboration:
  { label: 'empty_file',           source: '',                     args: ['--json', '--root=/work', '/work/Input.lean'] },
  // Just a comment:
  { label: 'comment_only',         source: '-- nothing\n',         args: ['--json', '--root=/work', '/work/Input.lean'] },
  // --deps doesn't elaborate, just parses imports:
  { label: 'deps_no_imports',      source: '-- nothing\n',         args: ['--deps', '--root=/work', '/work/Input.lean'] },
  // print-libdir doesn't touch file at all:
  { label: 'print_libdir',         source: null,                   args: ['--print-libdir'] },
  // Single trivial def — should elaborate fast:
  { label: 'simple_def',           source: 'def x : Nat := 42\n', args: ['--json', '--root=/work', '/work/Input.lean'] },
];

(async () => {
  for (const c of cases) {
    process.stdout.write(`=== ${c.label} ===\n  args=${JSON.stringify(c.args)}\n`);
    const r = run(c.label, c.source, c.args);
    if (r.status === 'ok') {
      const stdout = (r.stdout || '').slice(0, 200);
      const stderr = (r.stderr || '').slice(0, 200);
      console.log(`  status=ok exit=${r.exit} ms=${r.ms} stdout.len=${(r.stdout||'').length} stderr.len=${(r.stderr||'').length}`);
      if (stdout) console.log(`  stdout: ${JSON.stringify(stdout)}`);
      if (stderr) console.log(`  stderr: ${JSON.stringify(stderr)}`);
    } else {
      console.log(`  status=${r.status}`);
      if (r.stderr) console.log(`  stderr: ${(r.stderr || '').slice(-300)}`);
    }
  }
})();
