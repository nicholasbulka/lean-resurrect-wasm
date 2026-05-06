// Lean WASM worker. Runs entirely off the browser main thread so that:
//   - SharedArrayBuffer + Atomics.wait work freely
//   - long-running emcc-runtime calls don't peg the UI
//   - the worker can call Module._main directly (synchronous), bypassing
//     the v4.27 build's `--entry=_emscripten_proxy_main` async dispatch
//
// Wire protocol (main → worker):
//   { type: "init",   leanJsUrl, manifestUrl }
//   { type: "compile", requestId, source, libraryPaths }
//
// Worker → main:
//   { type: "ready" }                               (after init)
//   { type: "progress", phase, current?, total?, message? }
//   { type: "result",  requestId, result }          (CompileResult shape)
//   { type: "error",   requestId, error }
//
// We're a classic worker (no `type: "module"`) so we get `importScripts`,
// which is the simplest way to load the (very large) emcc bundle.

// Don't declare a top-level `let Module` — lean.js (loaded via importScripts)
// itself does `var Module = typeof Module != "undefined" ? Module : {}`, and
// any prior lexical `let Module` would collide ("Identifier already declared").
// Read/write via `self.Module` instead.
let leanLoadedPromise = null;
let initEntries = null;

// --- helpers ---------------------------------------------------------------

function postProgress(p) {
  postMessage({ type: 'progress', ...p });
}

// Pose as Node so Lean's CLI EM_ASM passes its `process.release.name === "node"`
// check. We don't try to run Node-specific FS code; preRun stages everything
// in MEMFS instead.
function installNodeShim() {
  if (typeof self.process === 'undefined') {
    self.process = {
      release: { name: 'node' },
      env: { HOME: '/home/user', TMPDIR: '/tmp', USER: 'user', PATH: '/usr/local/bin' },
      cwd: () => '/',
      argv: ['lean'],
      platform: 'linux',
    };
  }
  if (typeof self.__filename === 'undefined') {
    // Make this deep enough that IO.appDir = '/lean/bin', and
    // (IO.appDir).parent = '/lean' — required by Lean's
    // getBuildDir (Lean/Util/Path.lean:81) which calls .get!
    // on the parent and panics if it's none.
    self.__filename = '/lean/bin/lean';
    self.__dirname = '/lean/bin';
  }
}

function setupModule(leanJsBaseUrl, leanJsUrl, oleanBytes) {
  self.Module = {
    arguments: [],
    thisProgram: '/lean',
    noInitialRun: true,
    // EXIT_RUNTIME=1 was baked into the build, but at runtime Module
    // honours noExitRuntime to keep the WASM instance alive past
    // main's return. Required so we can run multiple compiles against
    // the same Module without paying the 200+ MB lean.{js,wasm} reload
    // cost each time.
    // noExitRuntime: false means the runtime tears down after main exits
    // and Module.onExit fires reliably. The trade-off is no reuse for
    // multiple compiles per worker — but in PROXY_TO_PTHREAD mode we
    // can't reliably observe the proxied main's exit otherwise.
    noExitRuntime: false,
    // CRITICAL: emcc captures `out`/`err` from Module.print/printErr at
    // WASM module-load time (before any compile runs). Reassigning
    // Module.print later — as we used to do per-compile — has NO
    // effect because emcc's `out` already holds the original reference.
    // Use stable functions that read per-compile state from a slot, and
    // swap that slot's contents in compile() instead of reassigning the
    // function on Module.
    print: function (...a) {
      const slot = self.__leanCurrentBuffers;
      if (slot) slot.stdout += a.join(' ') + '\n';
    },
    printErr: function (...a) {
      const slot = self.__leanCurrentBuffers;
      if (slot) slot.stderr += a.join(' ') + '\n';
    },
    locateFile: (p) => leanJsBaseUrl + p,
    // Without this, emcc-spawned pthread workers default to `_scriptName`
    // which inside our outer worker resolves to `/leanWorker.js`, not the
    // intended `/vendor/bin/lean.js`. The pthread workers then load the
    // wrong script and `calledRun` never fires.
    mainScriptUrlOrBlob: leanJsUrl,
    preRun: [
      function () {
        const FS = self.Module.FS;
        const NODEFS = self.Module.NODEFS;
        const MEMFS = self.Module.MEMFS;
        // NODEFS→MEMFS redirect: Lean's CLI EM_ASM mounts NODEFS at /home,
        // /tmp; we don't have NODEFS in a worker, so fall through to MEMFS.
        const origMount = FS.mount.bind(FS);
        FS.mount = function (type, opts, mountpoint) {
          if (type === NODEFS) return origMount(MEMFS, {}, mountpoint);
          return origMount(type, opts, mountpoint);
        };
        // ENV: Lean uses --print-libdir or LEAN_PATH to find stdlib;
        // there's no real install prefix here, so point LEAN_PATH at
        // /lib/lean where preRun stages oleans. Assign back onto Module.ENV
        // (the `|| {}` fallback creates a detached object otherwise).
        if (!Module.ENV) Module.ENV = {};
        const ENV = Module.ENV;
        for (const [k, v] of Object.entries(self.process.env || {})) {
          if (v != null) ENV[k] = String(v);
        }
        ENV.LEAN_PATH = '/lib/lean';
        ENV.LEAN_SYSROOT = '/';
        // Clear emcc's getEnvStrings cache so subsequent getenv()
        // reads see what we just set (rather than a snapshot from
        // before preRun).
        if (Module.getEnvStrings && Module.getEnvStrings.strings) {
          Module.getEnvStrings.strings = undefined;
        }
        // Stage oleans.
        for (const { path, bytes } of oleanBytes) {
          const full = '/lib/lean/' + path;
          try { FS.mkdirTree(full.slice(0, full.lastIndexOf('/'))); } catch (_) {}
          FS.writeFile(full, bytes);
        }
        try { FS.mkdirTree('/work'); } catch (_) {}
        try { FS.mkdirTree('/home/user'); } catch (_) {}
        // Lean's getBuildDir computes `(IO.appDir).parent.get!` from
        // __filename = /lean/bin/lean, returning /lean. Some downstream
        // code stats /lean/bin, so create the directory tree even
        // though we keep the actual oleans at /lib/lean.
        try { FS.mkdirTree('/lean/bin'); } catch (_) {}
        try { FS.mkdirTree('/lean/lib/lean'); } catch (_) {}
      },
    ],
    onAbort: (what) => {
      // Surface aborts so the main thread can fail the in-flight compile
      // rather than silently hanging.
      postMessage({ type: 'abort', what: String(what) });
    },
  };
  // self.Module already set above; lean.js's `var Module = typeof Module
  // != "undefined" ? Module : {}` will pick it up during importScripts.
}

function waitForCalledRun() {
  let lastLog = 0;
  return new Promise((resolve) => {
    const check = () => {
      if (self.Module.calledRun) {
        resolve();
        return;
      }
      // Periodically log waited-on flags so we can diagnose hangs.
      const now = Date.now();
      if (now - lastLog > 2000) {
        const m = self.Module;
        console.log('[leanWorker] waiting for calledRun: '
          + 'wasmBinary=' + (typeof m.wasmBinary)
          + ' wasmMemory=' + (typeof m.wasmMemory)
          + ' calledRun=' + m.calledRun
          + ' instantiateWasm=' + (typeof m.instantiateWasm)
          + ' onRuntimeInitialized=' + (typeof m.onRuntimeInitialized)
          + ' runtimeInitialized=' + m.runtimeInitialized
          + ' preRun=' + (Array.isArray(m.preRun) ? m.preRun.length : typeof m.preRun)
          + ' workersStarted=' + (m.PThread?.unusedWorkers?.length || 0)
        );
        lastLog = now;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

// --- init: download lean.js + manifest + Init oleans, instantiate WASM ----

async function init(leanJsUrl, manifestUrl, cache) {
  cache = cache || {};
  const usedCache = {
    wasmModule: !!cache.cachedWasmModule,
    oleans: !!cache.cachedOleans,
    leanJsSource: !!cache.cachedLeanJsSource,
  };
  console.log('[leanWorker] init: leanJsUrl=' + leanJsUrl + ' cache=' + JSON.stringify(usedCache));
  installNodeShim();
  // Force Lean's std::thread::hardware_concurrency() (which maps to
  // navigator.hardwareConcurrency) to 1 so its task manager doesn't try
  // to spawn 8+ pthread workers from inside the lean_main pthread —
  // that path deadlocks in browser context. Lean ignores LEAN_NUM_THREADS
  // under Emscripten (runtime/object.cpp guards it with #ifndef
  // LEAN_EMSCRIPTEN), so this is the only knob we have without a rebuild.
  try {
    Object.defineProperty(self.navigator, 'hardwareConcurrency', {
      value: 1, configurable: true, writable: false,
    });
    console.log('[leanWorker] navigator.hardwareConcurrency forced to 1');
  } catch (e) {
    console.log('[leanWorker] could not override hardwareConcurrency: ' + e.message);
  }

  // Fire all three independent fetches in parallel: oleans bundle,
  // lean.js source, and lean.wasm (compiled to a WebAssembly.Module).
  // Sequential download was ~10-30s on cold cache; parallel cuts that
  // to roughly the slowest of the three. WASM compile (the dominant
  // CPU cost) overlaps with the network-bound bundle fetch.
  const baseUrl = leanJsUrl.slice(0, leanJsUrl.lastIndexOf('/') + 1);
  const wasmUrl = baseUrl + 'lean.wasm';

  const oleansPromise = (async () => {
    if (cache.cachedOleans) {
      console.log('[leanWorker] oleans: cached (' + cache.cachedOleans.length + ' entries)');
      postProgress({ phase: 'fetching-oleans', current: cache.cachedOleans.length, total: cache.cachedOleans.length, message: 'oleans cached' });
      return cache.cachedOleans;
    }
    postProgress({ phase: 'fetching-oleans', message: 'downloading olean bundle' });
    const r = await fetch('/vendor/oleans.bundle');
    if (!r.ok) throw new Error('bundle fetch failed: ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    console.log('[leanWorker] bundle: ' + (buf.byteLength / 1048576).toFixed(1) + ' MB');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();
    const count = dv.getUint32(0, true);
    let off = 4;
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const pathLen = dv.getUint16(off, true); off += 2;
      const p = dec.decode(buf.subarray(off, off + pathLen)); off += pathLen;
      const dataLen = dv.getUint32(off, true); off += 4;
      const bytes = buf.subarray(off, off + dataLen); off += dataLen;
      out[i] = { path: p, bytes };
      if ((i & 1023) === 0) {
        postProgress({ phase: 'fetching-oleans', current: i, total: count, message: 'unpacking olean bundle' });
      }
    }
    console.log('[leanWorker] unpacked ' + out.length + ' oleans from bundle');
    postProgress({ phase: 'fetching-oleans', current: count, total: count, message: 'oleans ready' });
    return out;
  })();

  const leanJsSourcePromise = (async () => {
    if (cache.cachedLeanJsSource) {
      console.log('[leanWorker] lean.js source: cached (' + cache.cachedLeanJsSource.length + ' chars)');
      return cache.cachedLeanJsSource;
    }
    console.log('[leanWorker] fetching lean.js for patching...');
    const r = await fetch(leanJsUrl);
    if (!r.ok) throw new Error('fetch ' + leanJsUrl + ': ' + r.status);
    let s = await r.text();
    const PATCH_V415_OLD = 'var sharedModules=Module["sharedModules"]||[];';
    const PATCH_V415_NEW = 'Module.callMain=callMain;var sharedModules=Module["sharedModules"]||[];';
    const PATCH_V427_OLD = 'function callMain(args=[]){';
    const PATCH_V427_NEW = 'Module["callMain"]=callMain;function callMain(args=[]){';
    if (s.includes(PATCH_V415_OLD)) {
      s = s.replace(PATCH_V415_OLD, PATCH_V415_NEW);
      console.log('[leanWorker] applied v4.15 callMain patch');
    } else if (s.includes(PATCH_V427_OLD)) {
      s = s.replace(PATCH_V427_OLD, PATCH_V427_NEW);
      console.log('[leanWorker] applied v4.27 callMain patch');
    } else {
      console.log('[leanWorker] no callMain patch anchor matched; assuming native export');
    }
    const PATCH_EM_ASM_OLD = /(\d+):\(\)=>\{if\(typeof process==="undefined"\|\|process\.release\.name!=="node"\)\{throw new Error\("The Lean command-line driver[\s\S]*?FS\.chdir\(process\.cwd\(\)\)\}/;
    const PATCH_EM_ASM_NEW = '$1:()=>{/* CLI Node-check stripped by leanWorker shim */}';
    const beforeLen = s.length;
    s = s.replace(PATCH_EM_ASM_OLD, PATCH_EM_ASM_NEW);
    if (s.length !== beforeLen) console.log('[leanWorker] stripped CLI Node-check EM_ASM');
    // emcc's runtime does `var ENV={};Module["ENV"]=ENV;` which CLOBBERS
    // any Module.ENV we pre-set in setupModule / the patched prefix.
    // Replace with a preserve-pre-existing variant so our LEAN_PATH /
    // LEAN_SYSROOT survive into Lean's IO.getEnv calls.
    const PATCH_ENV_OLD = 'var ENV={};Module["ENV"]=ENV;Module["ENV"]=ENV;';
    const PATCH_ENV_NEW = 'var ENV=Module["ENV"]||{};Module["ENV"]=ENV;';
    const beforeEnv = s.length;
    s = s.replace(PATCH_ENV_OLD, PATCH_ENV_NEW);
    if (s.length !== beforeEnv) console.log('[leanWorker] preserved pre-existing Module.ENV');
    return s;
  })();

  const wasmModulePromise = (async () => {
    if (cache.cachedWasmModule) {
      console.log('[leanWorker] wasm module: cached');
      return cache.cachedWasmModule;
    }
    postProgress({ phase: 'loading-wasm', message: 'compiling lean.wasm' });
    console.log('[leanWorker] compileStreaming(' + wasmUrl + ')...');
    const t0 = Date.now();
    const mod = await WebAssembly.compileStreaming(fetch(wasmUrl));
    console.log('[leanWorker] WASM compiled in ' + (Date.now() - t0) + 'ms');
    return mod;
  })();

  const [oleanBytes, src, wasmModule] = await Promise.all([
    oleansPromise, leanJsSourcePromise, wasmModulePromise,
  ]);
  initEntries = oleanBytes;

  setupModule(baseUrl, leanJsUrl, oleanBytes);
  postProgress({ phase: 'loading-wasm', message: 'instantiating WASM runtime' });
  // Build a Blob URL so both this worker AND the emcc-spawned pthread
  // workers load the patched source. We MUST give pthread workers the
  // patched URL too, because the EM_ASM Node-check fires inside the
  // proxied lean_main (which runs on a pthread); the pthread worker
  // re-loads lean.js from `mainScriptUrlOrBlob`, and an unpatched copy
  // there throws and kills the whole compile.
  // Wrap the Worker constructor so we can listen to messages emcc-spawned
  // pthread workers post. Inside each pthread, the patched lean.js (Blob
  // URL below) overrides Module.print/printErr to postMessage with
  // typed envelopes {__leanStdout, __leanStderr}. Without the wrapping,
  // pthread output would land in the pthread worker's invisible console.
  // Multiple listeners on a Worker are fine — emcc's PThread machinery
  // also addEventListener('message') for its own protocol.
  const PthreadOutputBuf = { stdout: '', stderr: '' };
  self.__leanPthreadBuf = PthreadOutputBuf;
  const origWorkerCtor = self.Worker;
  self.Worker = function PatchedWorker(url, options) {
    const w = new origWorkerCtor(url, options);
    w.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m && typeof m === 'object') {
        if (m.__leanStdout !== undefined) PthreadOutputBuf.stdout += m.__leanStdout + '\n';
        if (m.__leanStderr !== undefined) PthreadOutputBuf.stderr += m.__leanStderr + '\n';
      }
    });
    return w;
  };
  Object.setPrototypeOf(self.Worker, origWorkerCtor);
  self.Worker.prototype = origWorkerCtor.prototype;

  const blob = new Blob([src], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  // Re-point the pthread workers at the patched blob.
  self.Module.mainScriptUrlOrBlob = blobUrl;

  // Hook Module.instantiateWasm to use the WebAssembly.Module we
  // already compiled in parallel with the bundle/lean.js fetches.
  // Skips emcc's default fetch+compile entirely.
  self.__leanCapturedWasmModule = wasmModule;
  self.Module.instantiateWasm = function (imports, successCallback) {
    WebAssembly.instantiate(wasmModule, imports).then(
      function (instance) { successCallback(instance, wasmModule); },
      function (err) { console.log('[leanWorker] instantiateWasm failed: ' + err); throw err; }
    );
    return {};
  };
  console.log('[leanWorker] instantiateWasm hook installed (' + (cache.cachedWasmModule ? 'cached' : 'eager-compiled') + ')');

  console.log('[leanWorker] importScripts(patched lean.js)...');
  importScripts(blobUrl);
  console.log('[leanWorker] importScripts done');

  postProgress({ phase: 'loading-wasm', message: 'instantiating WASM runtime' });
  await waitForCalledRun();
  console.log('[leanWorker] calledRun=true; callMain typeof=' + typeof self.Module.callMain + ' _main typeof=' + typeof self.Module._main);

  if (typeof self.Module.callMain !== 'function' && typeof self.Module._main !== 'function') {
    throw new Error('leanWorker: neither Module.callMain nor Module._main is exposed');
  }

  // Ship loaded state back to the main page so subsequent worker spawns
  // can skip the work. Only post what wasn't already provided by the
  // cache (otherwise we'd double-store on every spawn).
  const cachePayload = { type: 'cache-fill' };
  if (!usedCache.wasmModule && self.__leanCapturedWasmModule) {
    cachePayload.wasmModule = self.__leanCapturedWasmModule;
  }
  if (!usedCache.oleans) {
    cachePayload.oleans = oleanBytes;
  }
  if (!usedCache.leanJsSource) {
    cachePayload.leanJsSource = src;
  }
  if (cachePayload.wasmModule || cachePayload.oleans || cachePayload.leanJsSource) {
    try {
      postMessage(cachePayload);
      console.log('[leanWorker] cache-fill posted: ' + Object.keys(cachePayload).filter(k => k !== 'type').join(','));
    } catch (e) {
      console.log('[leanWorker] cache-fill postMessage failed: ' + e.message);
    }
  }

  postMessage({ type: 'ready' });
  console.log('[leanWorker] ready posted');
}

// --- per-compile entry: re-arm output capture, write source, run main -----

async function compile(requestId, source, libraryPaths) {
  const M = self.Module;
  if (!M || !M.calledRun) {
    postMessage({ type: 'error', requestId, error: 'leanWorker: WASM not initialized' });
    return;
  }

  const started = Date.now();
  // Per-compile buffer slot. Module.print captured at module-load reads
  // from self.__leanCurrentBuffers; we swap its contents per compile.
  const buffers = { stdout: '', stderr: '' };
  self.__leanCurrentBuffers = buffers;
  // Reset cross-pthread output buffers so they only collect THIS compile.
  if (self.__leanPthreadBuf) {
    self.__leanPthreadBuf.stdout = '';
    self.__leanPthreadBuf.stderr = '';
  }

  const ENV = M.ENV || {};
  if (libraryPaths && libraryPaths.length) {
    ENV.LEAN_EXTRA_PATH = libraryPaths.join(':');
  } else {
    delete ENV.LEAN_EXTRA_PATH;
  }

  const FS = M.FS;
  const enc = new TextEncoder();
  FS.writeFile('/work/Input.lean', enc.encode(source));

  let exitCode = -1;
  try {
    // With PROXY_TO_PTHREAD=1, callMain dispatches to _emscripten_proxy_main
    // which spawns a pthread to run lean_main and returns synchronously
    // on the calling thread. That sync return is meaningless — what we
    // want is the proxied main's actual exit. emcc fires Module.onExit
    // for that (whether EXIT_RUNTIME tears down or noExitRuntime keeps
    // it alive, the onExit hook still runs).
    const exitPromise = new Promise((resolve) => {
      M.onExit = (code) => resolve(typeof code === 'number' ? code : 0);
    });
    // For now, run --version as a smoke test before trying real elaboration.
    // If --version returns OK we know the bootstrap works; the elaboration
    // path may still trap due to libuv stub gaps.
    const args = source.startsWith('@@version') ? ['--version'] : ['--json', '--root=/work', '/work/Input.lean'];
    console.log('[leanWorker] callMain args=' + JSON.stringify(args));
    // Two completion paths:
    //   A. callMain returns a number synchronously — true for v4.15-style
    //      builds (no PROXY_TO_PTHREAD); main runs inline on this worker.
    //      Use that number as the exit code immediately.
    //   B. PROXY_TO_PTHREAD builds: callMain dispatches to
    //      _emscripten_proxy_main, which returns a queueing-ack number
    //      synchronously *before* main actually runs. That number is NOT
    //      the real exit code — Lean main hasn't started yet. We must
    //      ignore the sync return and wait for Module.onExit.
    // emcc's PThread namespace exists iff the build is MT/PROXY_TO_PTHREAD.
    const isProxyBuild = typeof M.PThread === 'object' && M.PThread !== null;
    const sync = M.callMain(args);
    const TIMEOUT_MS = 180_000;
    const timed = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('main never returned (no onExit) after ' + TIMEOUT_MS + 'ms')), TIMEOUT_MS));
    if (isProxyBuild) {
      exitCode = await Promise.race([exitPromise, timed]);
    } else {
      exitCode = typeof sync === 'number'
        ? sync
        : await Promise.race([exitPromise, timed]);
    }
    console.log('[leanWorker] main exited with ' + exitCode + ' stdout.len=' + buffers.stdout.length + ' stderr.len=' + buffers.stderr.length);
  } catch (e) {
    console.log('[leanWorker] compile threw: ' + (e?.message || String(e)));
    // Surface buffered output even on error so we can tell what Lean got
    // through before it traps.
    postMessage({
      type: 'error',
      requestId,
      error: (e && e.message) || String(e),
      partialStdout: buffers.stdout,
      partialStderr: buffers.stderr,
    });
    return;
  }

  // Merge in pthread-relayed output (PROXY_TO_PTHREAD: lean_main runs in
  // a pthread whose Module.print posts {__leanStdout} to us; the wrapped
  // Worker constructor in init() catches them into __leanPthreadBuf).
  if (self.__leanPthreadBuf) {
    if (self.__leanPthreadBuf.stdout) buffers.stdout += self.__leanPthreadBuf.stdout;
    if (self.__leanPthreadBuf.stderr) buffers.stderr += self.__leanPthreadBuf.stderr;
  }
  const { diagnostics, residualStdout } = parseJsonDiagnostics(buffers.stdout);
  postMessage({
    type: 'result',
    requestId,
    result: {
      stdout: residualStdout,
      stderr: buffers.stderr,
      exitCode,
      ms: Date.now() - started,
      diagnostics,
    },
  });
}

function parseJsonDiagnostics(stdout) {
  const diagnostics = [];
  const residual = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.severity && obj.pos && typeof obj.pos.line === 'number') {
          diagnostics.push(obj);
          continue;
        }
      } catch (_) {}
    }
    residual.push(line);
  }
  return { diagnostics, residualStdout: residual.join('\n') };
}

// --- message dispatcher ---------------------------------------------------

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'init') {
    if (leanLoadedPromise) return;
    leanLoadedPromise = init(msg.leanJsUrl, msg.manifestUrl, {
      cachedWasmModule: msg.cachedWasmModule,
      cachedOleans: msg.cachedOleans,
      cachedLeanJsSource: msg.cachedLeanJsSource,
    }).catch((e) => {
      postMessage({ type: 'init-error', error: (e && e.message) || String(e) });
    });
    return;
  }
  if (msg.type === 'compile') {
    (async () => {
      if (!leanLoadedPromise) {
        postMessage({ type: 'error', requestId: msg.requestId, error: 'leanWorker: send init before compile' });
        return;
      }
      await leanLoadedPromise;
      compile(msg.requestId, msg.source, msg.libraryPaths);
    })();
    return;
  }
};
