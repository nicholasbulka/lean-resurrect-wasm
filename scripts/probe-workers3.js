#!/usr/bin/env node
// Replace __pthread_create_js's body to throw, so we get the wasm-level
// stack at the call site.

const driver = `
(() => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const LEAN_ROOT = '/tmp/leanroot';
  let src = fs.readFileSync(LEAN_ROOT + '/bin/lean.js', 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\\d+):\\(\\)=>\\{if\\(typeof process==="undefined"\\|\\|process\\.release\\.name!=="node"\\)\\{throw new Error\\("The Lean command-line driver[\\s\\S]*?FS\\.chdir\\(process\\.cwd\\(\\)\\)\\}/, '$1:()=>{}');

  // Replace __pthread_create_js's body with a stack-throw to dump the WASM
  // call-site. The function definition in Emscripten is roughly:
  //   function __pthread_create_js(pthread_ptr, attr, startRoutine, arg) {...}
  // Locate it and wrap.
  // Real definition: var ___pthread_create_js=(pthread_ptr,attr,startRoutine,arg)=>{...
  src = src.replace(
    /var ___pthread_create_js=\\(([^)]*)\\)=>\\{/,
    'var ___pthread_create_js=($1)=>{console.error("[__pthread_create_js called]");try{throw new Error("stack");}catch(e){console.error(e.stack.split("\\\\n").slice(0,40).join("\\\\n"))}'
  );

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

  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
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
const child = spawn('node', ['--max-old-space-size=10240', '--stack-trace-limit=60', '-e', driver], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
setTimeout(() => { console.error('[host] kill'); child.kill('SIGKILL'); }, 8000);
child.on('exit', (c, s) => console.error('[host] exit', c, s));
