#!/usr/bin/env node
// Patch lean.js so that:
//  - Pthread workers (PROXY_TO_PTHREAD=1 build) inherit a NODEFS mount and
//    relay print/printErr back to the main thread.
//  - Lean's CLI-only EM_ASM that bails when not run from `node bin/lean.js`
//    is stubbed out (we drive callMain explicitly).
//  - Module.callMain is exposed so harnesses can invoke lean main() with
//    custom args after .calledRun.
//
// The patch is idempotent: reads the file, returns early if the
// `// LEAN_NODEFS_PATCHED` sentinel is already at the top.
//
// Usage:
//   node scripts/patch-leanjs.js [path/to/lean.js]
//   LEAN_INSTALL_DIR=/abs/path/to/lean-install-root node scripts/patch-leanjs.js
//
// The mount path is derived from the lean.js path's parent.parent (so
// `<root>/bin/lean.js` mounts `<root>` at `<root>` inside the WASM FS for
// 1:1 path correspondence). Override with LEAN_INSTALL_DIR.

const fs = require('fs');
const path = require('path');

const leanJsPath = path.resolve(process.argv[2] || process.env.LEAN_JS_PATH || '/tmp/leanroot/bin/lean.js');
const installDir = path.resolve(process.env.LEAN_INSTALL_DIR || path.dirname(path.dirname(leanJsPath)));

const src = fs.readFileSync(leanJsPath, 'utf8');
if (src.startsWith('// LEAN_NODEFS_PATCHED')) {
  console.log('[patch] already patched, skipping: ' + leanJsPath);
  process.exit(0);
}

// Inject a Module-bootstrap prefix that runs before lean.js's own `var
// Module=...` line. We populate globalThis.Module here, so when lean.js
// executes `var Module = typeof Module != "undefined" ? Module : {}` the
// global lookup resolves to our pre-populated config.
//
// Subprocess workers (em-pthread) re-import lean.js fresh, so this prefix
// runs in those contexts too — that's why the worker-specific setup
// (noInitialRun, print/printErr postMessage relay) lives here rather than
// in a per-call harness.
const prefix = `// LEAN_NODEFS_PATCHED
(function(){
  // The patch operates in two execution contexts:
  //   1. Node.js (CJS require of lean.js, including pthread workers
  //      spawned via worker_threads). Sets up NODEFS mounts + ENV
  //      forwarding. Here \`require\` is available.
  //   2. Browser Web Worker (importScripts of lean.js inside leanWorker.js).
  //      No \`require\`, no Node fs / worker_threads. Skip all Node-only
  //      setup; the browser worker (leanWorker.js) does its own preRun.
  var IS_NODE = typeof process !== 'undefined' && typeof require === 'function';
  if (!IS_NODE) {
    // Browser path. The outer leanWorker.js handles main-thread setup
    // (NODEFS→MEMFS shim, olean staging, etc). But pthread workers
    // spawned by Emscripten inside that outer worker re-import lean.js
    // FRESH and need their own gating, otherwise they auto-run _main()
    // with empty argv before the proxy from main fires the real call,
    // and Lean exits in milliseconds with 0 diagnostics.
    var isBrowserPthread =
      typeof self !== 'undefined' &&
      typeof self.name === 'string' &&
      self.name.indexOf('em-pthread') === 0;
    try {
      console.log('[lean.js patch] browser path: isBrowserPthread=' + isBrowserPthread + ' self.name=' + (typeof self !== 'undefined' ? self.name : '<no self>'));
    } catch (_) {}
    if (isBrowserPthread) {
      // Lean's runtime calls std::thread::hardware_concurrency() to size its
      // task pool. Under Emscripten that maps to navigator.hardwareConcurrency
      // (typically 8-16). With PTHREAD_POOL_SIZE=4 and PROXY_TO_PTHREAD using
      // one slot for lean_main, spawning that many sub-pthreads from inside
      // the lean_main pthread can deadlock. Force it to 1. (LEAN_NUM_THREADS
      // is ignored under #ifdef LEAN_EMSCRIPTEN in runtime/object.cpp, so
      // this is the only knob we have without a Lean rebuild.)
      try {
        Object.defineProperty(self.navigator, 'hardwareConcurrency', {
          value: 1, configurable: true, writable: false,
        });
      } catch (_) {}
      // Lean's IO.appPath EM_ASM in runtime/io.cpp checks process.release.name
      // and reads __filename. The pthread Worker scope has neither, so
      // appPath returns 0 and Lean errors with "no Lean executable file
      // exists in WASM outside of Node.js" — even before --version prints.
      // Install a Node shim local to the pthread.
      if (typeof self.process === 'undefined') {
        self.process = {
          release: { name: 'node' },
          env: { HOME: '/home/user', TMPDIR: '/tmp', USER: 'user' },
          cwd: function () { return '/'; },
          argv: ['lean'],
          platform: 'linux',
        };
      }
      if (typeof self.__filename === 'undefined') {
        self.__filename = '/lean';
        self.__dirname = '/';
      }
      var existing0 = (typeof globalThis.Module !== 'undefined') ? globalThis.Module : (typeof Module !== 'undefined' ? Module : {});
      Module = Object.assign({ noInitialRun: true, noExitRuntime: false }, existing0);
      Module.noInitialRun = true;
      // Pthread workers' default print/printErr goes to the worker's own
      // console (invisible). Relay via self.postMessage so the outer
      // leanWorker.js can capture it. Outer worker listens on each
      // spawned Worker's 'message' event for these typed envelopes.
      Module.print = function () {
        var msg = Array.prototype.slice.call(arguments).join(' ');
        try { self.postMessage({ __leanStdout: msg }); } catch (_) {}
      };
      Module.printErr = function () {
        var msg = Array.prototype.slice.call(arguments).join(' ');
        try { self.postMessage({ __leanStderr: msg }); } catch (_) {}
      };
      globalThis.Module = Module;
    }
    return;
  }
  var path = require('path');
  var fs = require('fs');
  var worker_threads = require('worker_threads');
  var isPthread = !worker_threads.isMainThread &&
    worker_threads.workerData === 'em-pthread';

  // Canonical install dir: try realpath first (macOS /tmp → /private/tmp),
  // then process env, then fall back to the static path baked at patch-time.
  var __installDir = ${JSON.stringify(installDir)};
  try { __installDir = fs.realpathSync(__installDir); } catch (_) {}

  var existing = (typeof globalThis.Module !== 'undefined')
    ? globalThis.Module
    : (typeof Module !== 'undefined' ? Module : {});

  var defaults = {
    locateFile: function (p) { return path.join(__installDir, 'bin', p); },
    thisProgram: path.join(__installDir, 'bin', 'lean.js'),
    noExitRuntime: false,
  };
  // Pthread workers must NOT run _main() with empty argv on instantiation.
  // The proxy from the main thread will fire _emscripten_proxy_main with
  // the real argv. Without this guard the worker prints help text and exits
  // before the main thread can dispatch a real call.
  if (isPthread) defaults.noInitialRun = true;

  Module = Object.assign(defaults, existing);
  if (isPthread) Module.noInitialRun = true;
  globalThis.Module = Module;

  // Worker print/printErr → postMessage to parent. The main thread wraps
  // worker_threads.Worker below to listen for these and re-emit via
  // Module.print/printErr (which the harness has overridden for capture).
  if (isPthread) {
    Module.print = function () {
      var msg = Array.prototype.slice.call(arguments).join(' ');
      try { worker_threads.parentPort.postMessage({ __leanStdout: msg }); } catch (_) {}
    };
    Module.printErr = function () {
      var msg = Array.prototype.slice.call(arguments).join(' ');
      try { worker_threads.parentPort.postMessage({ __leanStderr: msg }); } catch (_) {}
    };
  }

  Module.preRun = (Module.preRun || []).concat([function () {
    var FS = Module.FS, NODEFS = Module.NODEFS;
    try { FS.mkdirTree(__installDir); } catch (_) {}
    try { FS.mount(NODEFS, { root: __installDir }, __installDir); } catch (_) {}
    try { FS.mkdirTree('/work'); } catch (_) {}
    // Mount the host's cwd inside the WASM FS at the same path so user
    // files (passed by absolute path on the command line) are reachable.
    // Workers inherit process.cwd() from the parent, so this runs
    // uniformly on main thread and pthread workers.
    try {
      var cwd = fs.realpathSync(process.cwd());
      if (cwd && cwd !== __installDir && !cwd.startsWith(__installDir + '/')) {
        FS.mkdirTree(cwd);
        FS.mount(NODEFS, { root: cwd }, cwd);
      }
    } catch (_) {}
    // Pthread workers re-instantiate lean.js with a fresh Module (and a
    // fresh closure-scoped var ENV). LEAN_PATH set on the main-thread
    // Module never reaches them. Workers DO inherit process.env via
    // worker_threads, so we hydrate Module.ENV from process.env here.
    // Main thread also benefits from this for callers that pass LEAN_PATH
    // via env vars instead of preRun.
    if (!Module.ENV) Module.ENV = {};
    var FORWARD = ['LEAN_PATH', 'LEAN_PATH_OVERRIDE', 'LEAN_EXTRA_PATH', 'LEAN_SYSROOT', 'LEAN_SRC_PATH', 'HOME', 'USER'];
    for (var i = 0; i < FORWARD.length; i++) {
      var k = FORWARD[i];
      if (process.env[k] !== undefined && Module.ENV[k] === undefined) {
        Module.ENV[k] = process.env[k];
      }
    }
    // If LEAN_EXTRA_PATH is set but LEAN_PATH isn't, build LEAN_PATH from
    // extra:stdlib here too so workers don't need a separate override.
    if (Module.ENV.LEAN_EXTRA_PATH && !Module.ENV.LEAN_PATH) {
      Module.ENV.LEAN_PATH = Module.ENV.LEAN_EXTRA_PATH + ':' + path.join(__installDir, 'lib/lean');
    }
    if (!Module.ENV.LEAN_PATH) Module.ENV.LEAN_PATH = path.join(__installDir, 'lib/lean');
    if (!Module.ENV.LEAN_SYSROOT) Module.ENV.LEAN_SYSROOT = __installDir;
    // Clear getEnvStrings cache: emscripten caches the env string array on
    // first call. If anything called environ_get before our preRun set up
    // ENV (unlikely but defensive), the cache would be stale. Module.
    // getEnvStrings is exposed by emcc.
    if (typeof Module.getEnvStrings === 'function' && Module.getEnvStrings.strings) {
      Module.getEnvStrings.strings = undefined;
    }
  }]);

  // Main thread only: hook Worker so output messages from pthread workers
  // route into Module.print/printErr (whatever the harness configured).
  if (!isPthread) {
    var origWorker = worker_threads.Worker;
    function PatchedWorker(filename, options) {
      var w = new origWorker(filename, options);
      w.on('message', function (m) {
        if (m && typeof m === 'object') {
          if (m.__leanStdout !== undefined && Module.print) Module.print(m.__leanStdout);
          if (m.__leanStderr !== undefined && Module.printErr) Module.printErr(m.__leanStderr);
        }
      });
      return w;
    }
    Object.setPrototypeOf(PatchedWorker, origWorker);
    PatchedWorker.prototype = origWorker.prototype;
    worker_threads.Worker = PatchedWorker;
    global.Worker = PatchedWorker;
  }
})();
`;

// Strip Lean's CLI-driver EM_ASM (throws if process.release.name !== 'node',
// then chdirs to the host cwd). We invoke callMain ourselves.
let patched = src.replace(
  /(\d+):\(\)=>\{if\(typeof process==="undefined"\|\|process\.release\.name!=="node"\)\{throw new Error\("The Lean command-line driver[\s\S]*?FS\.chdir\(process\.cwd\(\)\)\}/,
  '$1:()=>{}'
);

if (patched === src) {
  console.error('[patch] WARN: did not find the EM_ASM CLI-check pattern; lean.js shape may have changed');
}

// Expose callMain on Module so harnesses can call it with args after init.
patched = patched.replace(
  'function callMain(args=[]){',
  'Module["callMain"]=callMain;function callMain(args=[]){'
);

// Expose the closure-scoped `var ENV={}` as Module.ENV so harnesses (and
// preRun) can set environment variables before getEnvStrings() runs.
// Without this, `Module.ENV.LEAN_PATH = ...` writes to a different object
// and Lean's getenv() never sees it.
patched = patched.replace(
  'var ENV={};',
  'var ENV={};Module["ENV"]=ENV;'
);

fs.writeFileSync(leanJsPath, prefix + patched);
console.log('[patch] wrote ' + leanJsPath + ' (mount = ' + installDir + ')');
