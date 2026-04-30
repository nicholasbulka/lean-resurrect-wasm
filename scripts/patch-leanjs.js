#!/usr/bin/env node
// Injects NODEFS preRun setup directly into lean.js so workers (which
// re-instantiate Module on import) inherit the mount. Idempotent.
//
// Usage: node scripts/patch-leanjs.js [lean.js path, default /tmp/leanroot/bin/lean.js]

const fs = require('fs');
const path = process.argv[2] || '/tmp/leanroot/bin/lean.js';
const src = fs.readFileSync(path, 'utf8');

if (src.includes('// LEAN_NODEFS_PATCHED')) {
  console.log('[patch] already patched, skipping');
  process.exit(0);
}

// The injected block:
// - Defines Module with preRun that mounts host /tmp/leanroot at /tmp/leanroot
//   inside the WASM FS (1:1 path mirror so __filename works in both views).
// - Adds noExitRuntime, locateFile (so .wasm loads from same dir).
// - Drops Lean's CLI-only EM_ASM that throws "command-line driver" error
//   (we apply the same regex strip as the harness used to do at runtime).
const injectionPrefix = `// LEAN_NODEFS_PATCHED
(function(){
  var path = require('path');
  var fs = require('fs');
  var worker_threads = require('worker_threads');
  var isPthread = !worker_threads.isMainThread &&
    worker_threads.workerData === 'em-pthread';
  // Resolve /tmp/leanroot to its canonical host path. On macOS /tmp is a
  // symlink to /private/tmp, and Lean uses realpath internally — so we
  // mount the canonical path inside the WASM FS so paths line up.
  var __hostRoot = '/tmp/leanroot';
  try { __hostRoot = fs.realpathSync('/tmp/leanroot'); } catch(_) {}
  var __leanRoot = __hostRoot;
  var existing = (typeof globalThis.Module !== 'undefined') ? globalThis.Module : (typeof Module !== 'undefined') ? Module : {};
  // Defaults that existing harness Module can override via Object.assign.
  // For pthread workers (no harness in scope), we force noInitialRun:true
  // so the worker doesn't run _main() with empty argv before main thread
  // proxies the real call. For main thread we leave it to the harness.
  var defaults = {
    locateFile: function(p) { return path.join(__leanRoot + '/bin', p); },
    thisProgram: __leanRoot + '/bin/lean.js',
    noExitRuntime: false,
  };
  if (isPthread) defaults.noInitialRun = true;
  Module = Object.assign(defaults, existing);
  // BUT: in pthread, noInitialRun must always be true regardless of harness
  // (the harness lives on the main thread; workers don't see it anyway —
  // existing is empty in workers — but be defensive).
  if (isPthread) Module.noInitialRun = true;
  globalThis.Module = Module;
  // Worker threads need print/printErr that reach the parent. Without
  // overrides they default to console.log inside the worker, which goes
  // to the worker's own stdout (piped, not visible).
  if (isPthread) {
    process.stderr.write('[lean-pthread-init] noInitialRun=' + Module.noInitialRun + ' thisProgram=' + Module.thisProgram + '\\n');
    Module.print = function() {
      var msg = Array.prototype.slice.call(arguments).join(' ');
      worker_threads.parentPort.postMessage({ __leanStdout: msg });
    };
    Module.printErr = function() {
      var msg = Array.prototype.slice.call(arguments).join(' ');
      worker_threads.parentPort.postMessage({ __leanStderr: msg });
    };
  }
  Module.preRun = (Module.preRun || []).concat([function() {
    var FS = Module.FS, NODEFS = Module.NODEFS;
    try { FS.mkdirTree(__leanRoot); }
    catch(e) { console.error('[lean.js patch] mkdirTree:', e && (e.message || e.errno || e)); }
    try { FS.mount(NODEFS, { root: __leanRoot }, __leanRoot); }
    catch(e) { console.error('[lean.js patch] mount:', e && (e.message || e.errno || e)); }
    try {
      if (__leanRoot !== '/tmp/leanroot') {
        FS.mkdirTree('/tmp');
        FS.symlink(__leanRoot, '/tmp/leanroot');
      }
    } catch(_) {}
    try { FS.mkdirTree('/work'); } catch(_) {}
  }]);
  // Main thread: hook newly-spawned workers to relay __leanStdout/__leanStderr
  // back into Module.print/printErr (so the harness sees the output).
  if (!isPthread) {
    var origWorker = worker_threads.Worker;
    worker_threads.Worker = function(filename, options) {
      var w = new origWorker(filename, options);
      w.on('message', function(m) {
        if (m && typeof m === 'object') {
          if (m.__leanStdout !== undefined && Module.print) Module.print(m.__leanStdout);
          if (m.__leanStderr !== undefined && Module.printErr) Module.printErr(m.__leanStderr);
        }
      });
      return w;
    };
    Object.setPrototypeOf(worker_threads.Worker, origWorker);
    worker_threads.Worker.prototype = origWorker.prototype;
    global.Worker = worker_threads.Worker;
  }
})();
`;

// Strip the Lean CLI-driver EM_ASM that throws on non-CLI invocation.
let patched = src.replace(
  /(\d+):\(\)=>\{if\(typeof process==="undefined"\|\|process\.release\.name!=="node"\)\{throw new Error\("The Lean command-line driver[\s\S]*?FS\.chdir\(process\.cwd\(\)\)\}/,
  '$1:()=>{}'
);

if (patched === src) {
  console.error('[patch] WARN: did not find the EM_ASM CLI-check pattern; lean.js shape may have changed');
}

// Expose callMain so the harness can invoke lean main() repeatedly.
patched = patched.replace(
  'function callMain(args=[]){',
  'Module["callMain"]=callMain;function callMain(args=[]){'
);

fs.writeFileSync(path, injectionPrefix + patched);
console.log('[patch] wrote ' + path + ' (' + patched.length + ' bytes payload + ' + injectionPrefix.length + ' prefix)');
