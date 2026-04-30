#!/usr/bin/env node
// During the hang, list active handles to see what's holding the loop
// open. Specifically: are there pthread Workers stuck somewhere?

const { spawn } = require('child_process');

const driver = `
(() => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const LEAN_ROOT = '/tmp/leanroot';
  let src = fs.readFileSync(LEAN_ROOT + '/bin/lean.js', 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\\d+):\\(\\)=>\\{if\\(typeof process==="undefined"\\|\\|process\\.release\\.name!=="node"\\)\\{throw new Error\\("The Lean command-line driver[\\s\\S]*?FS\\.chdir\\(process\\.cwd\\(\\)\\)\\}/, '$1:()=>{}');
  global.__filename = '/leanroot/bin/lean.js';
  global.__dirname = '/leanroot/bin';

  const wt = require('worker_threads');
  const origWorker = wt.Worker;
  let workerCount = 0;
  wt.Worker = class extends origWorker {
    constructor(filename, options) {
      workerCount++;
      console.error('[WORKER spawn #' + workerCount + ']', filename, JSON.stringify(options).slice(0, 200));
      super(filename, options);
      this.on('exit', (code) => console.error('[WORKER #' + workerCount + ' exit] code=' + code));
      this.on('error', (e) => console.error('[WORKER #' + workerCount + ' error]', e.message));
    }
  };
  // Also wire the global one if module looks for it:
  global.Worker = wt.Worker;

  let stdoutBuf = '', stderrBuf = '';
  global.Module = {
    noInitialRun: true, noExitRuntime: false, thisProgram: LEAN_ROOT + '/bin/lean.js',
    print: (...a) => { stdoutBuf += a.join(' ') + '\\n'; console.error('[lean stdout]', ...a); },
    printErr: (...a) => { stderrBuf += a.join(' ') + '\\n'; console.error('[lean stderr]', ...a); },
    locateFile: (p) => path.join(LEAN_ROOT + '/bin', p),
    preRun: [function () {
      const FS = global.Module.FS, NODEFS = global.Module.NODEFS;
      try { FS.mkdirTree('/leanroot'); } catch(_){}
      FS.mount(NODEFS, { root: LEAN_ROOT }, '/leanroot');
      try { FS.mkdirTree('/work'); } catch(_){}
      FS.writeFile('/work/Input.lean', new TextEncoder().encode(''));
    }],
    onAbort: (what) => { console.error('ABORT=' + what); process.exit(3); },
  };
  vm.runInThisContext(src);

  // Periodic dump of active handles.
  const hT = setInterval(() => {
    const handles = process._getActiveHandles();
    const names = handles.map(h => {
      try { return h.constructor && h.constructor.name; } catch(_) { return '?'; }
    });
    console.error('[T+' + ((Date.now() - startT)/1000).toFixed(1) + 's] handles=' + handles.length + ' kinds=' + JSON.stringify(names));
  }, 1500);
  hT.unref();

  const startT = Date.now();
  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
    console.error('[calledRun] T+' + ((Date.now() - startT)/1000).toFixed(1));
    let exit = -1;
    try { const ret = global.Module.callMain(['--json', '--root=/work', '/work/Input.lean']); exit = (typeof ret === 'number') ? ret : -2; }
    catch (e) { exit = (e && e.status !== undefined) ? e.status : 'THREW:' + (e && e.message || e); }
    console.error('[done] exit=' + exit + ' ms=' + (Date.now()-startT));
    process.exit(0);
  };
  wait();
})();
`;

const child = spawn('node', ['--max-old-space-size=10240', '-e', driver], {
  stdio: ['ignore', 'inherit', 'inherit'],
});

setTimeout(() => {
  console.error('[host] killing child after 8s');
  child.kill('SIGKILL');
}, 8000);

child.on('exit', (code, signal) => {
  console.error('[host] child exit code=' + code + ' signal=' + signal);
});
