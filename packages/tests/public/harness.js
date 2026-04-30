// Browser harness for v4.15.0 linux_wasm32 lean.wasm.
//
// Shims: process (no versions.node), __filename, NODEFS→MEMFS redirect.
// Modes (URL params):
//   ?args=--version                              default
//   ?args=--server                               LSP mode (drive via window.leanSend)
//   ?args=-o,/work/out.olean,/work/in.lean       arbitrary argv
//   ?file=trivial.lean                           fetch + compile this file
//   ?trace=1                                     capture FS.stat/open into window.__fsTrace
//   ?seed=init                                   fetch Init/* oleans into /lib/lean/ (~86 MB)
//   ?seed=all                                    fetch entire stdlib (~510 MB)
//   ?seed=none                                   don't seed (default)
//
// LSP mode (?args=--server):
//   window.leanSend(obj)     — send a JSON-RPC request to Lean
//   window.leanOnMessage(fn) — register a callback for incoming frames
//   window.__leanLspMessages — queue of received LSP messages
//
// The flow is:
//   1. Set up shims + Module config.
//   2. If ?file= is set, fetch the input before touching lean.js.
//   3. Inject <script src=lean.js>; its preRun writes the input into MEMFS
//      synchronously, so main() has the file by the time it runs.

(function () {
  const out = document.getElementById('out');
  const stateEl = document.getElementById('state');
  function setState(s) {
    window.__leanState = s;
    if (stateEl) { stateEl.textContent = s; stateEl.className = 'state ' + s; }
  }
  function log() {
    const args = Array.prototype.slice.call(arguments);
    const s = args.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    if (out) out.textContent += s + '\n';
    console.log.apply(console, ['[harness]'].concat(args));
  }

  setState('booting');
  window.__leanErrors = [];
  window.__fsTrace = [];

  window.addEventListener('error', (e) => {
    const msg = (e.error && e.error.message) || e.message || String(e);
    window.__leanErrors.push(msg);
    log('window error:', msg);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = (e.reason && e.reason.message) || String(e.reason);
    window.__leanErrors.push(msg);
    log('unhandledrejection:', msg);
  });

  window.__crossOriginIsolated = typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
  window.__hasSAB = typeof SharedArrayBuffer !== 'undefined';
  log('crossOriginIsolated:', window.__crossOriginIsolated, ' SharedArrayBuffer:', window.__hasSAB);

  // Instrument Atomics.wait on the main thread: browsers forbid blocking
  // Atomics.wait here (the spec requires throwing TypeError). If Lean's
  // pthread code path tries to block on main, we'll see it loud and clear.
  // Emscripten apps sidestep this with -s PROXY_TO_PTHREAD=1, which we
  // suspect the v4.15 WASM was built without.
  // Heartbeat: if this stops, main thread is blocked. If it keeps going
  // but Lean makes no progress, worker thread is blocked (or there is no
  // work queued).
  let heartbeat = 0;
  setInterval(() => {
    heartbeat += 1;
    if (heartbeat % 2 === 0) console.log('[heartbeat]', heartbeat, 'elapsed=', heartbeat * 0.5 + 's');
  }, 500);

  if (typeof Atomics !== 'undefined' && typeof Atomics.wait === 'function') {
    const origWait = Atomics.wait.bind(Atomics);
    let waitCount = 0;
    Atomics.wait = function(typedArray, index, value, timeout) {
      waitCount += 1;
      console.log('[harness:atomics.wait]', waitCount, 'timeout=', timeout, 'stack=', new Error().stack?.split('\n').slice(1, 5).join(' | '));
      try {
        const r = origWait(typedArray, index, value, timeout);
        console.log('[harness:atomics.wait] returned', r);
        return r;
      } catch (e) {
        console.log('[harness:atomics.wait] THREW', e && e.message);
        throw e;
      }
    };
    Atomics.waitAsync = Atomics.waitAsync || (() => { console.log('[harness] no Atomics.waitAsync'); });
    window.__atomicsWaitCount = () => waitCount;
  }

  // --- Shim 1: pass Node-only check; keep ENVIRONMENT_IS_NODE=false.
  if (typeof globalThis.process === 'undefined') {
    globalThis.process = {
      release: { name: 'node' },
      env: {
        HOME: '/home/user',
        TMPDIR: '/tmp',
        USER: 'user',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        // Force single-threaded elaboration. Lean's pthread workers in
        // browser have been observed to hang after the startup panic —
        // plausibly because one worker aborts and main waits on its task.
        LEAN_NUM_THREADS: '1',
        LEAN_ABORT_ON_PANIC: '0',
      },
      cwd: () => '/',
      argv: ['lean'],
      platform: 'linux',
    };
    log('installed process shim; ENVIRONMENT_IS_NODE stays false');
  }
  if (typeof globalThis.__filename === 'undefined') {
    globalThis.__filename = '/lean';
    globalThis.__dirname = '/';
  }

  const params = new URLSearchParams(location.search);
  const traceEnabled = params.get('trace') === '1';
  const fileUrl = params.get('file');
  const argStr = params.get('args');
  const seedMode = params.get('seed') || 'none';

  let inputDestPath = null;
  let inputBytes = null;
  /** @type {Array<{ path: string, bytes: Uint8Array }>} */
  let seededOleans = [];

  async function fetchAllBytes(urls, concurrency = 16) {
    const out = new Array(urls.length);
    let i = 0;
    async function worker() {
      while (i < urls.length) {
        const my = i++;
        const r = await fetch(urls[my]);
        if (!r.ok) throw new Error('fetch ' + urls[my] + ' -> ' + r.status);
        out[my] = new Uint8Array(await r.arrayBuffer());
      }
    }
    const workers = [];
    for (let k = 0; k < concurrency; k++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  async function setup() {
    // 1. Fetch input file.
    if (fileUrl) {
      try {
        const r = await fetch(fileUrl);
        if (!r.ok) throw new Error('fetch ' + fileUrl + ' -> ' + r.status);
        inputBytes = new Uint8Array(await r.arrayBuffer());
        inputDestPath = '/work/' + (fileUrl.split('/').pop() || 'input.lean');
        log('fetched input:', fileUrl, '→', inputDestPath, '(' + inputBytes.length + ' bytes)');
      } catch (e) {
        log('input fetch failed:', (e && e.message) || e);
      }
    }

    // 2. Seed oleans. We do this BEFORE lean.js loads so preRun can stage
    // them synchronously into the VFS. Lean expects them at /lib/lean/
    // (confirmed by `lean --print-libdir` in-browser).
    if (seedMode !== 'none') {
      try {
        log('fetching manifest...');
        const manifest = await (await fetch('/vendor/manifest.json')).json();
        const filter = seedMode === 'init'
          ? (e) => e.path === 'Init.olean' || e.path.startsWith('Init/')
          : () => true;
        const entries = manifest.entries.filter(filter);
        const totalMB = Math.round(entries.reduce((a, e) => a + e.size, 0) / 1024 / 1024);
        log(`seeding ${entries.length} oleans (~${totalMB} MiB) from ${manifest.root}`);
        const urls = entries.map((e) => manifest.root + '/' + e.path);
        const started = performance.now();
        const allBytes = await fetchAllBytes(urls, 16);
        const elapsed = Math.round(performance.now() - started);
        seededOleans = entries.map((e, i) => ({ path: e.path, bytes: allBytes[i] }));
        log(`seed fetch complete: ${entries.length} files in ${elapsed}ms`);
      } catch (e) {
        log('seed fetch failed:', (e && e.message) || e);
      }
    }

    let leanArgs;
    if (inputDestPath) leanArgs = [inputDestPath];
    else if (argStr) leanArgs = argStr.split(',').filter(Boolean);
    else leanArgs = ['--version'];
    log('lean args:', JSON.stringify(leanArgs));

    // LSP wiring: if args include --server, set up a byte-queue stdin and a
    // stdout framer that parses "Content-Length: N\r\n\r\n<json>" messages.
    const lspMode = leanArgs.includes('--server');
    window.__leanLspMessages = [];
    const lspListeners = [];
    window.leanOnMessage = (fn) => { lspListeners.push(fn); };
    let stdinQueue = []; // one byte per element (number)
    window.leanSend = (obj) => {
      const body = JSON.stringify(obj);
      const bytes = new TextEncoder().encode(body);
      const headerBytes = new TextEncoder().encode('Content-Length: ' + bytes.length + '\r\n\r\n');
      for (const b of headerBytes) stdinQueue.push(b);
      for (const b of bytes) stdinQueue.push(b);
      log('→ LSP', JSON.stringify(obj).slice(0, 200));
    };
    // stdout framing state
    let stdoutBuffer = '';
    function feedStdout(chunk) {
      stdoutBuffer += chunk;
      while (true) {
        const headerEnd = stdoutBuffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = stdoutBuffer.slice(0, headerEnd);
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { stdoutBuffer = stdoutBuffer.slice(headerEnd + 4); continue; }
        const len = Number(m[1]);
        const bodyStart = headerEnd + 4;
        if (stdoutBuffer.length < bodyStart + len) return; // wait for more
        const body = stdoutBuffer.slice(bodyStart, bodyStart + len);
        stdoutBuffer = stdoutBuffer.slice(bodyStart + len);
        try {
          const msg = JSON.parse(body);
          window.__leanLspMessages.push(msg);
          for (const fn of lspListeners) { try { fn(msg); } catch (_) {} }
          log('← LSP', JSON.stringify(msg).slice(0, 200));
        } catch (e) {
          log('LSP parse error', e.message, body.slice(0, 200));
        }
      }
    }

    window.Module = {
      arguments: leanArgs,
      thisProgram: '/lean',
      // In LSP mode stdout is JSON-RPC; keep it out of the UI log.
      print: (...a) => {
        const line = a.join(' ');
        if (lspMode) feedStdout(line + '\n');
        else log('stdout:', line);
      },
      printErr: (...a) => log('stderr:', a.join(' ')),
      // stdin: one byte per call, null for EOF. The lean process reads
      // from stdin when running --server; we feed LSP frames via leanSend.
      stdin: lspMode ? (() => (stdinQueue.length ? stdinQueue.shift() : null)) : undefined,
      locateFile: (p) => '/vendor/bin/' + p,
      onAbort: (what) => { setState('aborted'); log('onAbort:', what); },
      onRuntimeInitialized: () => { setState('runtimeInitialized'); log('onRuntimeInitialized'); },
      preInit: [() => log('preInit')],
      preRun: [function () {
        log('preRun');
        const FS = Module.FS;
        const NODEFS = Module.NODEFS;
        const MEMFS = Module.MEMFS;

        // --- Shim 2: redirect NODEFS → MEMFS.
        if (FS && NODEFS && MEMFS) {
          const origMount = FS.mount.bind(FS);
          FS.mount = function (type, opts, mountpoint) {
            if (type === NODEFS) {
              log('redirecting NODEFS→MEMFS at', mountpoint);
              return origMount(MEMFS, {}, mountpoint);
            }
            return origMount(type, opts, mountpoint);
          };
        }

        // --- Optional: FS tracing. Streams via console so it's visible even
        // if the tab hangs/crashes. Skips /dev/* spam.
        if (traceEnabled) {
          const origStat = FS.stat.bind(FS);
          FS.stat = function (p, dontFollow) {
            let ok = true;
            try { return origStat(p, dontFollow); }
            catch (e) { ok = false; throw e; }
            finally {
              const entry = (ok ? 'stat ok  ' : 'stat ENO ') + p;
              window.__fsTrace.push(entry);
              if (!p.startsWith('/dev/')) console.log('[fs]', entry);
            }
          };
          const origOpen = FS.open.bind(FS);
          FS.open = function (p, flags, mode) {
            let ok = true;
            try { return origOpen(p, flags, mode); }
            catch (e) { ok = false; throw e; }
            finally {
              const entry = (ok ? 'open ok  ' : 'open ENO ') + p + ' flags=' + flags;
              window.__fsTrace.push(entry);
              if (!p.startsWith('/dev/')) console.log('[fs]', entry);
            }
          };
          log('FS tracing enabled (streaming via console)');
        }

        // Stage seeded oleans into /lib/lean/.
        if (seededOleans.length) {
          const started = performance.now();
          for (const { path, bytes } of seededOleans) {
            const full = '/lib/lean/' + path;
            // Create parent directories.
            const slash = full.lastIndexOf('/');
            const dir = full.slice(0, slash);
            try { FS.mkdirTree(dir); } catch (_) {}
            FS.writeFile(full, bytes);
          }
          const elapsed = Math.round(performance.now() - started);
          log(`staged ${seededOleans.length} oleans into /lib/lean/ in ${elapsed}ms`);
          // Free the seed buffer — it's in MEMFS now.
          seededOleans = [];
        }

        // Stage the input file.
        if (inputDestPath && inputBytes) {
          try { FS.mkdirTree('/work'); } catch (_) {}
          FS.writeFile(inputDestPath, inputBytes);
          log('staged input at', inputDestPath);
        }

        try { FS.mkdirTree('/home/user'); } catch (_) {}
        try { FS.mkdirTree('/tmp'); } catch (_) {}

        // If in LSP mode and the page pre-queued messages on window.__lspPreQueue,
        // drain them into stdin NOW (before Lean main starts reading).
        if (lspMode && Array.isArray(window.__lspPreQueue)) {
          for (const msg of window.__lspPreQueue) {
            window.leanSend(msg);
          }
          log('drained', window.__lspPreQueue.length, 'pre-queued LSP messages');
        }

        // Copy process.env → Emscripten's ENV. Required because `lean_io_getenv`
        // under LEAN_EMSCRIPTEN reads from ENV via EM_ASM, not from process.env.
        // Without this, Lean.IO.getEnv "HOME" returns None and Option.get!
        // panics somewhere upstream.
        const ENV = Module.ENV || {};
        for (const [k, v] of Object.entries(globalThis.process.env || {})) {
          if (v != null) ENV[k] = String(v);
        }
        log('ENV keys set:', Object.keys(ENV).join(','));

        setTimeout(() => {
          if (window.__leanState === 'runtimeInitialized') setState('running');
        }, 0);
      }],
    };

    const s = document.createElement('script');
    s.src = '/vendor/bin/lean.js';
    s.async = false;
    s.onerror = () => { setState('scriptError'); log('script load error'); };
    document.head.appendChild(s);
  }

  setup();
})();
