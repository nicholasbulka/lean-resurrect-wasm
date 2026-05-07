#!/usr/bin/env node
// Run the patched lean.js with custom args, capturing stdout/stderr/exit.
//
// The vendored lean.js has been patched (see scripts/patch-leanjs.js) so
// that:
//   - pthread workers initialise correctly (noInitialRun, NODEFS mount)
//   - workers relay print/printErr postMessages back to main
//   - Lean's CLI EM_ASM is stubbed (we drive callMain explicitly)
//
// What this harness adds on top of the patch:
//   - Pre-set globalThis.Module with print/printErr/onExit so we can capture
//     output and exit cleanly.
//   - Optional LEAN_PATH override + LEAN_EXTRA_PATH (BYOML).
//   - Optional LEAN_RESOLVER_JS — install an FS.stat/FS.open interceptor
//     that calls a JS resolver to fetch missing oleans on demand.
//
// Run: node --stack-size=8192 preflight/trace_fs.js [lean args...]

const path = require('path');
const fs = require('fs');

const INSTALL = fs.realpathSync(
  process.env.LEAN_INSTALL_DIR ||
    path.resolve(__dirname, '../vendor/lean-linux_wasm32')
);
const LEAN_JS = path.join(INSTALL, 'bin/lean.js');

// Sanity check: lean.js must have been patched.
if (!fs.readFileSync(LEAN_JS, 'utf8').startsWith('// LEAN_NODEFS_PATCHED')) {
  console.error('[harness] lean.js at ' + LEAN_JS + ' is not patched.');
  console.error('[harness] run: node scripts/patch-leanjs.js ' + LEAN_JS);
  process.exit(2);
}

let stdoutBuf = '';
let stderrBuf = '';

globalThis.Module = {
  noInitialRun: true,
  print: (...a) => {
    const line = a.join(' ') + '\n';
    stdoutBuf += line;
    process.stdout.write(line);
  },
  printErr: (...a) => {
    const line = '[lean] ' + a.join(' ') + '\n';
    stderrBuf += line;
    process.stderr.write(line);
  },
  onExit: (status) => {
    // status is the int exit code Lean returned.
    process.exit(status);
  },
  onAbort: (what) => {
    console.error('[harness] onAbort:', what);
    process.exit(3);
  },
  preRun: [function () {
    const FS = Module.FS;
    // Module.ENV may not exist yet at preRun time; ensure it does and
    // assign back so values reach Lean's getenv. (Without this, our
    // local ENV is a fresh {} that gets discarded.)
    if (!Module.ENV) Module.ENV = {};
    const ENV = Module.ENV;

    // LEAN_PATH precedence:
    //   1. LEAN_PATH_OVERRIDE  full override (resolver tests)
    //   2. LEAN_EXTRA_PATH     prepended to default stdlib (BYOML)
    //   3. stdlib only (default)
    const stdlib = path.join(INSTALL, 'lib/lean');
    const override = process.env.LEAN_PATH_OVERRIDE;
    const extra = process.env.LEAN_EXTRA_PATH;
    if (override) ENV.LEAN_PATH = override;
    else if (extra) ENV.LEAN_PATH = `${extra}:${stdlib}`;
    else ENV.LEAN_PATH = stdlib;
    // NOTE: v4.27 WASM Lean's init_search_path doesn't reliably pick up
    // LEAN_PATH from Module.ENV under PROXY_TO_PTHREAD. The install-prefix
    // path is the only one consulted. BYOML / olean-resolver flows that
    // depend on LEAN_PATH are blocked on this until we either:
    //   1. Patch shell.cpp to keep the EM_ASM ENV-propagation it relies
    //      on (we stripped the whole EM_ASM with the CLI node-check); or
    //   2. Stage user libs into the install-prefix dir host-side so
    //      they're found via the NODEFS mount. Tests that need this
    //      can do their own pre-stage; the harness no longer does it.

    ENV.LEAN_SRC_PATH = path.join(INSTALL, 'src/lean');
    ENV.LEAN_SYSROOT = INSTALL;
    ENV.HOME = '/Users/' + (process.env.USER || 'user');

    // Stage user-supplied input dir from the cwd up to the WASM FS so
    // arguments referring to host paths line up with realpath'd cwd.
    // Plus any extra dirs the caller wants reachable (e.g. an output
    // directory outside the cwd subtree). LEAN_EXTRA_MOUNTS is a
    // ':'-separated list of host paths.
    const mountedRoots = new Set();
    function mountIfNew(p) {
      try {
        const real = fs.realpathSync(p);
        if (real === INSTALL || real.startsWith(INSTALL + '/')) return;
        if (mountedRoots.has(real)) return;
        FS.mkdirTree(real);
        FS.mount(Module.NODEFS, { root: real }, real);
        mountedRoots.add(real);
      } catch (_) {}
    }
    try { mountIfNew(process.cwd()); } catch (_) {}
    if (process.env.LEAN_EXTRA_MOUNTS) {
      for (const m of process.env.LEAN_EXTRA_MOUNTS.split(':')) {
        if (m) mountIfNew(m);
      }
    }

    // Olean-on-demand: if LEAN_RESOLVER_JS is set, install an FS interceptor
    // that calls resolver.resolve(path) for missing *.olean.
    const resolverPath = process.env.LEAN_RESOLVER_JS;
    if (resolverPath) {
      let resolver;
      try {
        resolver = require(resolverPath);
        if (resolver && resolver.default) resolver = resolver.default;
      } catch (e) {
        console.error('[harness] failed to load resolver:', e && e.message);
        throw e;
      }
      if (typeof resolver.resolve !== 'function') {
        throw new Error(`[harness] resolver at ${resolverPath} must export .resolve(path) -> bytes|null`);
      }
      const calls = [];
      resolver.__calls = calls;

      // v4.27 module system: each module has up to four files; resolve any.
      const RESOLVABLE = ['.olean', '.olean.server', '.olean.private', '.ir'];
      function tryStage(p) {
        if (!p) return false;
        if (!RESOLVABLE.some((ext) => p.endsWith(ext))) return false;
        let bytes;
        try { bytes = resolver.resolve(p); }
        catch (re) { console.error('[harness] resolver threw for', p, re && re.message); return false; }
        if (!bytes) return false;
        calls.push(p);
        const parts = p.split('/').filter(Boolean);
        let acc = '';
        for (let i = 0; i < parts.length - 1; i++) {
          acc += '/' + parts[i];
          try { FS.mkdir(acc); } catch (_) {}
        }
        FS.writeFile(p, bytes);
        return true;
      }

      const origStat = FS.stat;
      FS.stat = function (p, dontFollow) {
        try { return origStat.call(FS, p, dontFollow); }
        catch (e) {
          if (e && e.errno === 44 && tryStage(p)) return origStat.call(FS, p, dontFollow);
          throw e;
        }
      };
      const origOpen = FS.open;
      const WRITE_MASK = 1 | 2 | 64;
      FS.open = function (p, flags, mode) {
        try { return origOpen.call(FS, p, flags, mode); }
        catch (e) {
          const flagsNum = typeof flags === 'number' ? flags : 0;
          const isRead = (flagsNum & WRITE_MASK) === 0;
          if (e && e.errno === 44 && isRead && tryStage(p)) return origOpen.call(FS, p, flags, mode);
          throw e;
        }
      };
    }
  }],
};

// Load the patched lean.js. The patch prefix runs first, populating
// Module with the NODEFS mount + worker bookkeeping while preserving our
// pre-set print/printErr/onExit/preRun.
require(LEAN_JS);

// Once Module.calledRun fires, dispatch callMain with our args. PROXY_TO_PTHREAD
// makes callMain return immediately on the main thread; the proxy fires _main
// in a worker which calls Module.onExit on completion.
const args = process.argv.slice(2).length ? process.argv.slice(2) : ['--version'];
const wait = () => {
  if (!globalThis.Module.calledRun) { setTimeout(wait, 50); return; }
  try { globalThis.Module.callMain(args); }
  catch (e) {
    console.error('[harness] callMain threw:', e && (e.message || e));
    process.exit(4);
  }
};
wait();

// Safety net: if onExit never fires, kill after 30 minutes.
// 10 minutes was too aggressive for Mathlib-class single-file
// elaborations (Aesop.Stats.Basic, Aesop.Util.Tactic.Ext etc.
// routinely cross 11 minutes during cold compile under our wasm32
// runtime). Override via LEAN_HARNESS_TIMEOUT_MS env var.
const HARNESS_TIMEOUT_MS = parseInt(process.env.LEAN_HARNESS_TIMEOUT_MS || '', 10) || 30 * 60_000;
setTimeout(() => {
  console.error('[harness] timeout — onExit never fired after ' + HARNESS_TIMEOUT_MS + 'ms');
  process.exit(124);
}, HARNESS_TIMEOUT_MS);

// Surface unhandled errors with as much context as we can get.
process.on('uncaughtException', (err) => {
  // 'unwind' is Emscripten's teardown signal that Asyncify-instrumented
  // builds throw on normal exit (specifically when Module.noExitRuntime
  // is false and main returns). It's NOT a real failure — the .olean
  // has already been written. Treat it as success.
  const msg = err && (err.message || err);
  if (msg === 'unwind' || msg === 'pthread_exit' || (err && err.name === 'ExitStatus')) {
    process.exit(0);
  }
  console.error('[harness] uncaughtException:', msg);
  console.error('[harness] errno:', err && err.errno, 'code:', err && err.code);
  process.exit(43);
});
process.on('unhandledRejection', (reason) => {
  console.error('[harness] unhandledRejection:', reason && (reason.message || reason));
  console.error('[harness] errno:', reason && reason.errno, 'code:', reason && reason.code);
  process.exit(42);
});
