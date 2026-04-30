#!/usr/bin/env node
// Directly call lean_internal_is_multi_thread on the loaded module to
// confirm what it returns in this binary.
const fs = require('fs'), path = require('path'), vm = require('vm');
const LEAN_ROOT = '/tmp/leanroot';

let src = fs.readFileSync(`${LEAN_ROOT}/bin/lean.js`, 'utf8');
src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
src = src.replace(/(\d+):\(\)=>\{if\(typeof process==="undefined"\|\|process\.release\.name!=="node"\)\{throw new Error\("The Lean command-line driver[\s\S]*?FS\.chdir\(process\.cwd\(\)\)\}/, '$1:()=>{}');

global.__filename = '/leanroot/bin/lean.js';
global.__dirname = '/leanroot/bin';
global.Module = {
  noInitialRun: true, noExitRuntime: false, thisProgram: `${LEAN_ROOT}/bin/lean.js`,
  print: (...a) => { console.log('[lean stdout]', ...a); },
  printErr: (...a) => { console.log('[lean stderr]', ...a); },
  locateFile: (p) => path.join(`${LEAN_ROOT}/bin`, p),
  preRun: [function () {
    const FS = global.Module.FS, NODEFS = global.Module.NODEFS;
    try { FS.mkdirTree('/leanroot'); } catch(_) {}
    FS.mount(NODEFS, { root: LEAN_ROOT }, '/leanroot');
  }],
  onAbort: (what) => { console.log('ABORT=' + what); process.exit(3); },
};

vm.runInThisContext(src);

const wait = () => {
  if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
  const M = global.Module;
  // Peek at exports
  console.log('typeof callMain:', typeof M.callMain);
  // Find lean_internal_is_multi_thread in exports
  const exp = M.asm || M; // emscripten 3.x: under Module's wasmExports
  // try common names:
  const names = ['_lean_internal_is_multi_thread', 'lean_internal_is_multi_thread'];
  let fn = null, found = null;
  for (const n of names) {
    if (typeof M[n] === 'function') { fn = M[n]; found = n; break; }
  }
  if (!fn && M.wasmExports) {
    for (const n of names) {
      if (typeof M.wasmExports[n] === 'function') { fn = M.wasmExports[n]; found = `wasmExports.${n}`; break; }
      const stripped = n.startsWith('_') ? n.slice(1) : n;
      if (typeof M.wasmExports[stripped] === 'function') { fn = M.wasmExports[stripped]; found = `wasmExports.${stripped}`; break; }
    }
  }
  console.log('found:', found);
  if (fn) {
    try {
      const result = fn(0);
      console.log('lean_internal_is_multi_thread(0) =', result);
    } catch (e) {
      console.log('call threw:', e.message || e);
    }
  } else {
    // Walk Module keys
    const keys = Object.keys(M).filter(k => k.toLowerCase().includes('multi'));
    console.log('keys with multi:', keys);
    if (M.wasmExports) {
      const k2 = Object.keys(M.wasmExports).filter(k => k.toLowerCase().includes('multi'));
      console.log('wasmExports with multi:', k2);
    }
  }
  process.exit(0);
};
wait();
