// Run the vendored linux_wasm32 lean.js under Node with our Module config.
//
// The vendored lean.js (Emscripten-generated) starts with:
//   var Module = typeof Module != "undefined" ? Module : {};
// In Node CJS, `var Module` is hoisted as a local undefined, shadowing
// globalThis.Module. To avoid modifying the release, we load the file's
// source, patch that one line in-memory, and compile it via Node's Module
// system so __filename / __dirname / require / worker_threads work normally.
//
// Run: node --stack-size=8192 preflight/trace_fs.js [lean args...]

const path = require('path');
const fs = require('fs');
const NodeModule = require('module');

const INSTALL = path.resolve(__dirname, '../vendor/lean-linux_wasm32');
const LEAN_JS = path.join(INSTALL, 'bin/lean.js');

process.on('unhandledRejection', (reason) => {
  console.error('[harness] unhandledRejection ctor:', reason && reason.constructor && reason.constructor.name);
  console.error('[harness] message:', reason && reason.message);
  console.error('[harness] errno:', reason && reason.errno, 'code:', reason && reason.code, 'path:', reason && reason.path);
  console.error('[harness] keys:', reason && Object.getOwnPropertyNames(reason));
  process.exit(42);
});
process.on('uncaughtException', (err) => {
  console.error('[harness] uncaughtException:', err && err.message);
  console.error('[harness] stack:', err && err.stack);
  process.exit(43);
});

globalThis.Module = {
  arguments: process.argv.slice(2).length ? process.argv.slice(2) : ['--version'],
  thisProgram: `${INSTALL}/bin/lean`,
  print: (...a) => process.stdout.write(a.join(' ') + '\n'),
  printErr: (...a) => process.stderr.write('[lean] ' + a.join(' ') + '\n'),
  locateFile: function (p) {
    const full = `${INSTALL}/bin/${p}`;
    console.error('[harness] locateFile', p, '->', full);
    return full;
  },
  preInit: [function () { console.error('[harness] preInit entered'); }],
  onAbort: function (what) { console.error('[harness] onAbort:', what); },
  onRuntimeInitialized: function () { console.error('[harness] onRuntimeInitialized'); },
  preRun: [
    function () {
      console.error('[harness] preRun entered; cwd=' + process.cwd());
      const FS = Module.FS;
      const NODEFS = Module.NODEFS;
      const ENV = Module.ENV || {};

      try { FS.mkdirTree('/Users'); } catch (e) {}
      try {
        FS.mount(NODEFS, { root: '/Users' }, '/Users');
        console.error('[harness] mounted /Users');
      } catch (e) {
        console.error('[harness] mount /Users failed:', e && e.message);
      }

      // LEAN_PATH resolution, precedence:
      //   1. LEAN_PATH_OVERRIDE (explicit full override; used by resolver tests)
      //   2. LEAN_EXTRA_PATH  prepended to default stdlib (BYOML)
      //   3. stdlib only (default)
      const stdlib = `${INSTALL}/lib/lean`;
      const override = process.env.LEAN_PATH_OVERRIDE;
      const extra = process.env.LEAN_EXTRA_PATH;
      if (override) ENV.LEAN_PATH = override;
      else if (extra) ENV.LEAN_PATH = `${extra}:${stdlib}`;
      else ENV.LEAN_PATH = stdlib;
      console.error('[harness] LEAN_PATH=' + ENV.LEAN_PATH);

      ENV.LEAN_SRC_PATH = `${INSTALL}/src/lean`;
      ENV.LEAN_SYSROOT = INSTALL;
      ENV.HOME = '/Users/' + (process.env.USER || 'user');

      // Olean-on-demand: if LEAN_RESOLVER_JS is set, require() that module
      // and install an FS.open interceptor. On ENOENT for a *.olean path,
      // invoke resolver.resolve(path) to get bytes; if resolver returns a
      // Uint8Array/Buffer we stage the file in the VFS and retry the open.
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

        // Try to fetch+stage bytes for a missing olean. Returns true if
        // staged successfully. Called from both FS.stat and FS.open catches
        // because Lean's module resolver stats candidates before opening.
        function tryStage(p) {
          if (!p || !p.endsWith('.olean')) return false;
          let bytes;
          try {
            bytes = resolver.resolve(p);
          } catch (re) {
            console.error('[harness] resolver.resolve threw for', p, re && re.message);
            return false;
          }
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
          try {
            return origStat.call(FS, p, dontFollow);
          } catch (e) {
            if (e && e.errno === 44 && tryStage(p)) {
              return origStat.call(FS, p, dontFollow);
            }
            throw e;
          }
        };

        const origOpen = FS.open;
        // Emscripten flags include O_LARGEFILE (32768); require write bits off.
        const WRITE_MASK = 1 | 2 | 64; // O_WRONLY | O_RDWR | O_CREAT
        FS.open = function (p, flags, mode) {
          try {
            return origOpen.call(FS, p, flags, mode);
          } catch (e) {
            const flagsNum = typeof flags === 'number' ? flags : 0;
            const isRead = (flagsNum & WRITE_MASK) === 0;
            if (e && e.errno === 44 && isRead && tryStage(p)) {
              return origOpen.call(FS, p, flags, mode);
            }
            throw e;
          }
        };
        console.error('[harness] olean resolver installed from', resolverPath);
      }
    },
  ],
};

// Load and patch lean.js in-memory.
const OLD = 'var Module=typeof Module!="undefined"?Module:{};';
const NEW = 'var Module=typeof globalThis!=="undefined"&&globalThis.Module?globalThis.Module:(typeof Module!="undefined"?Module:{});';
const src = fs.readFileSync(LEAN_JS, 'utf8');
if (!src.includes(OLD)) {
  console.error('[harness] expected Module pattern not found in lean.js — the release may have changed.');
  process.exit(2);
}
const patched = src.replace(OLD, NEW);

const leanModule = new NodeModule(LEAN_JS, module);
leanModule.filename = LEAN_JS;
leanModule.paths = NodeModule._nodeModulePaths(path.dirname(LEAN_JS));
leanModule._compile(patched, LEAN_JS);
