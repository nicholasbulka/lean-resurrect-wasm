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
    self.__filename = '/lean';
    self.__dirname = '/';
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
    noExitRuntime: true,
    print: (..._a) => {},      // re-armed per compile
    printErr: (..._a) => {},   // re-armed per compile
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
        // /lib/lean where preRun stages oleans.
        const ENV = Module.ENV || {};
        for (const [k, v] of Object.entries(self.process.env || {})) {
          if (v != null) ENV[k] = String(v);
        }
        ENV.LEAN_PATH = '/lib/lean';
        ENV.LEAN_SYSROOT = '/';
        // Stage oleans.
        for (const { path, bytes } of oleanBytes) {
          const full = '/lib/lean/' + path;
          try { FS.mkdirTree(full.slice(0, full.lastIndexOf('/'))); } catch (_) {}
          FS.writeFile(full, bytes);
        }
        try { FS.mkdirTree('/work'); } catch (_) {}
        try { FS.mkdirTree('/home/user'); } catch (_) {}
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

async function init(leanJsUrl, manifestUrl) {
  console.log('[leanWorker] init: leanJsUrl=' + leanJsUrl);
  installNodeShim();

  postProgress({ phase: 'fetching-manifest', message: 'fetching olean manifest' });
  const manifest = await (await fetch(manifestUrl)).json();
  initEntries = manifest.entries.filter(
    (e) => e.path === 'Init.olean' || e.path.startsWith('Init/')
  );
  console.log('[leanWorker] manifest: ' + initEntries.length + ' Init entries');

  postProgress({ phase: 'fetching-oleans', current: 0, total: initEntries.length, message: 'downloading Init oleans' });
  let done = 0;
  const oleanBytes = await Promise.all(
    initEntries.map(async (e) => {
      const r = await fetch(manifest.root + '/' + e.path);
      if (!r.ok) throw new Error('fetch ' + e.path);
      const bytes = new Uint8Array(await r.arrayBuffer());
      done += 1;
      postProgress({ phase: 'fetching-oleans', current: done, total: initEntries.length, message: 'downloading Init oleans' });
      return { path: e.path, bytes };
    })
  );
  console.log('[leanWorker] fetched ' + oleanBytes.length + ' oleans');

  // locateFile resolves "lean.wasm" against the directory of lean.js.
  const baseUrl = leanJsUrl.slice(0, leanJsUrl.lastIndexOf('/') + 1);
  setupModule(baseUrl, leanJsUrl, oleanBytes);

  postProgress({ phase: 'loading-wasm', message: 'loading lean.js' });
  console.log('[leanWorker] fetching lean.js for patching...');
  const r = await fetch(leanJsUrl);
  if (!r.ok) throw new Error('fetch ' + leanJsUrl + ': ' + r.status);
  let src = await r.text();
  // Expose callMain on Module. Two known anchor patterns: v4.15 / v4.27.
  const PATCH_V415_OLD = 'var sharedModules=Module["sharedModules"]||[];';
  const PATCH_V415_NEW = 'Module.callMain=callMain;var sharedModules=Module["sharedModules"]||[];';
  const PATCH_V427_OLD = 'function callMain(args=[]){';
  const PATCH_V427_NEW = 'Module["callMain"]=callMain;function callMain(args=[]){';
  if (src.includes(PATCH_V415_OLD)) {
    src = src.replace(PATCH_V415_OLD, PATCH_V415_NEW);
    console.log('[leanWorker] applied v4.15 callMain patch');
  } else if (src.includes(PATCH_V427_OLD)) {
    src = src.replace(PATCH_V427_OLD, PATCH_V427_NEW);
    console.log('[leanWorker] applied v4.27 callMain patch');
  } else {
    console.log('[leanWorker] no callMain patch anchor matched; assuming native export');
  }
  // We keep _emscripten_proxy_main as the entry: bypassing the proxy
  // ("call _main directly") leaves the pthread runtime state uninitialised
  // and Lean traps with `unreachable` on first thread-touching code path.
  // Instead we go through the proxy (callMain returns immediately) and
  // listen for Module.onExit to know when the proxied main truly finishes.
  // Module.noExitRuntime keeps the WASM instance alive after main exits so
  // subsequent compiles can reuse it.
  //
  // Strip Lean's CLI EM_ASM that throws when not running under Node.js.
  // We've already stubbed the FS mounts in preRun, so the body of that
  // EM_ASM is dead code from our perspective; replace it with a no-op.
  // We accept the negative match as silent (older v4.15 lacks this guard).
  const PATCH_EM_ASM_OLD = /(\d+):\(\)=>\{if\(typeof process==="undefined"\|\|process\.release\.name!=="node"\)\{throw new Error\("The Lean command-line driver[\s\S]*?FS\.chdir\(process\.cwd\(\)\)\}/;
  const PATCH_EM_ASM_NEW = '$1:()=>{/* CLI Node-check stripped by leanWorker shim */}';
  const beforeLen = src.length;
  src = src.replace(PATCH_EM_ASM_OLD, PATCH_EM_ASM_NEW);
  if (src.length !== beforeLen) {
    console.log('[leanWorker] stripped CLI Node-check EM_ASM');
  }
  // Build a Blob URL so both this worker AND the emcc-spawned pthread
  // workers load the patched source. We MUST give pthread workers the
  // patched URL too, because the EM_ASM Node-check fires inside the
  // proxied lean_main (which runs on a pthread); the pthread worker
  // re-loads lean.js from `mainScriptUrlOrBlob`, and an unpatched copy
  // there throws and kills the whole compile.
  const blob = new Blob([src], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  // Re-point the pthread workers at the patched blob.
  self.Module.mainScriptUrlOrBlob = blobUrl;
  console.log('[leanWorker] importScripts(patched lean.js)...');
  importScripts(blobUrl);
  // Don't revokeObjectURL: pthread workers may still be loading from it.
  console.log('[leanWorker] importScripts done');

  postProgress({ phase: 'loading-wasm', message: 'instantiating WASM runtime' });
  await waitForCalledRun();
  console.log('[leanWorker] calledRun=true; callMain typeof=' + typeof self.Module.callMain + ' _main typeof=' + typeof self.Module._main);

  if (typeof self.Module.callMain !== 'function' && typeof self.Module._main !== 'function') {
    throw new Error('leanWorker: neither Module.callMain nor Module._main is exposed');
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
  let stdoutBuf = '';
  let stderrBuf = '';
  M.print = (...a) => { stdoutBuf += a.join(' ') + '\n'; };
  M.printErr = (...a) => { stderrBuf += a.join(' ') + '\n'; };

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
    // Forward print/printErr live to the main thread so we can see what
    // Lean managed to write before any trap.
    M.print = (...a) => {
      const s = a.join(' ');
      stdoutBuf += s + '\n';
      console.log('[leanWorker:stdout]', s);
    };
    M.printErr = (...a) => {
      const s = a.join(' ');
      stderrBuf += s + '\n';
      console.log('[leanWorker:stderr]', s);
    };
    // Two completion paths:
    //   A. callMain returns a number synchronously — true for v4.15-style
    //      builds (no PROXY_TO_PTHREAD); main runs inline on this worker.
    //      Use that number as the exit code immediately.
    //   B. callMain returns void / undefined — proxy_main builds dispatch
    //      to a pthread. Wait for Module.onExit to know when main truly
    //      finishes.
    const sync = M.callMain(args);
    const TIMEOUT_MS = 30_000;
    const timed = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('main never returned (no onExit)')), TIMEOUT_MS));
    exitCode = typeof sync === 'number'
      ? sync
      : await Promise.race([exitPromise, timed]);
    console.log('[leanWorker] main exited with ' + exitCode + ' stdout.len=' + stdoutBuf.length + ' stderr.len=' + stderrBuf.length);
  } catch (e) {
    console.log('[leanWorker] compile threw: ' + (e?.message || String(e)));
    // Surface buffered output even on error so we can tell what Lean got
    // through before it traps.
    postMessage({
      type: 'error',
      requestId,
      error: (e && e.message) || String(e),
      partialStdout: stdoutBuf,
      partialStderr: stderrBuf,
    });
    return;
  }

  const { diagnostics, residualStdout } = parseJsonDiagnostics(stdoutBuf);
  postMessage({
    type: 'result',
    requestId,
    result: {
      stdout: residualStdout,
      stderr: stderrBuf,
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
    leanLoadedPromise = init(msg.leanJsUrl, msg.manifestUrl).catch((e) => {
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
