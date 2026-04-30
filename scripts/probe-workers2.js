#!/usr/bin/env node
// Capture WASM stack at the moment _pthread_create is invoked.

const driver = `
(() => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const LEAN_ROOT = '/tmp/leanroot';
  let src = fs.readFileSync(LEAN_ROOT + '/bin/lean.js', 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\\d+):\\(\\)=>\\{if\\(typeof process==="undefined"\\|\\|process\\.release\\.name!=="node"\\)\\{throw new Error\\("The Lean command-line driver[\\s\\S]*?FS\\.chdir\\(process\\.cwd\\(\\)\\)\\}/, '$1:()=>{}');
  // Hook __pthread_create_js with a stack-capturing wrapper. The function
  // is defined in the JS glue. Patch its definition.
  src = src.replace('function __pthread_create_js(', 'function __pthread_create_js_orig_DUMMY() {} function __pthread_create_js(');
  // simpler: just find the symbol and wrap.

  global.__filename = '/leanroot/bin/lean.js';
  global.__dirname = '/leanroot/bin';

  global.Module = {
    noInitialRun: true, noExitRuntime: false, thisProgram: LEAN_ROOT + '/bin/lean.js',
    print: (...a) => { console.error('[lean stdout]', ...a); },
    printErr: (...a) => { console.error('[lean stderr]', ...a); },
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

  // After eval, find __pthread_create_js in scope and wrap it via 'globalThis'
  // It is hoisted to var or function scope inside vm context but Module
  // sometimes also has it. Try several lookups.
  function findPC() {
    const cands = [
      typeof __pthread_create_js !== 'undefined' ? __pthread_create_js : null,
      global.__pthread_create_js,
      global.Module && global.Module.__pthread_create_js,
      global.Module && global.Module.wasmExports && global.Module.wasmExports.__pthread_create_js,
    ];
    return cands.find(Boolean);
  }

  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
    // Hook: scan keys of Module.wasmExports for pthread.
    const wexp = global.Module.wasmExports || {};
    const pcKeys = Object.keys(wexp).filter(k => /pthread/i.test(k));
    console.error('[wasmExports pthread keys]', pcKeys.slice(0, 20));

    // Hook _emscripten_async_run_in_main_runtime_thread + pthread Worker creation.
    // The actual spawn site in emscripten: called from emscripten_thread_init
    //  inside the Worker. The MAIN thread calls a function named like
    //  '_emscripten_thread_create' or registers via 'pthreadJS' in __pthread_create_js.
    //  Easiest hook: monkey-patch global.Worker (already done above implicitly?)

    const wt = require('worker_threads');
    const origWorker = wt.Worker;
    wt.Worker = class extends origWorker {
      constructor(filename, options) {
        const stack = new Error('Worker spawn').stack;
        console.error('[Worker spawn]', filename);
        console.error(stack.split('\\n').slice(1, 6).join('\\n'));
        super(filename, options);
      }
    };
    global.Worker = wt.Worker;

    let exit = -1;
    try { const ret = global.Module.callMain(['--json', '--root=/work', '/work/Input.lean']); exit = (typeof ret === 'number') ? ret : -2; }
    catch (e) { exit = (e && e.status !== undefined) ? e.status : 'THREW:' + (e && e.message || e); }
    console.error('[done] exit=' + exit);
    process.exit(0);
  };
  wait();
})();
`;

const { spawn } = require('child_process');
const child = spawn('node', ['--max-old-space-size=10240', '--stack-trace-limit=40', '-e', driver], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
setTimeout(() => { console.error('[host] kill'); child.kill('SIGKILL'); }, 8000);
child.on('exit', (c, s) => console.error('[host] exit', c, s));
