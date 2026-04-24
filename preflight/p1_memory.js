// Preflight P1: peak HEAP8.length during a stdlib-heavy Lean compile.
//
// Gate: peak < 3 GiB.
// Note: v4.15.0 tarball only ships Lean stdlib (Init/Std/Lean/Lake).
// Mathlib.Tactic.Linarith is not bundled. We use a stdlib-heavy proxy
// workload. Follow-up: download wasm32 Mathlib cache and re-run.

const path = require('path');
const fs = require('fs');
const NodeModule = require('module');

const INSTALL = path.resolve(__dirname, '../vendor/lean-linux_wasm32');
const LEAN_JS = path.join(INSTALL, 'bin/lean.js');
const LEAN_FILE = process.argv[2] || path.join(__dirname, 'leantest/Linarith.lean');

let peakBytes = 0;
let samples = 0;
const started = Date.now();

function sample() {
  try {
    const m = globalThis.Module;
    if (m && m.HEAP8 && m.HEAP8.length) {
      samples++;
      if (m.HEAP8.length > peakBytes) peakBytes = m.HEAP8.length;
    }
  } catch (e) {}
}
const poller = setInterval(sample, 50);
poller.unref();

process.on('exit', (code) => {
  sample();
  const peakMiB = (peakBytes / 1024 / 1024).toFixed(1);
  const peakGiB = (peakBytes / 1024 / 1024 / 1024).toFixed(3);
  const ms = Date.now() - started;
  console.error(`\n[p1] peak HEAP8.length = ${peakBytes} bytes = ${peakMiB} MiB = ${peakGiB} GiB`);
  console.error(`[p1] samples = ${samples}, wall time = ${(ms/1000).toFixed(1)}s, exit = ${code}`);
  const gate = 3 * 1024 * 1024 * 1024;
  if (peakBytes >= gate) {
    console.error('[p1] FAIL (>= 3 GiB) — project infeasible as scoped');
  } else {
    console.error('[p1] PASS (< 3 GiB)');
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[p1] unhandledRejection ctor:', reason && reason.constructor && reason.constructor.name);
  console.error('[p1] message:', reason && reason.message);
  console.error('[p1] errno:', reason && reason.errno);
  process.exit(42);
});

globalThis.Module = {
  arguments: [LEAN_FILE],
  thisProgram: `${INSTALL}/bin/lean`,
  print: (...a) => process.stdout.write(a.join(' ') + '\n'),
  printErr: (...a) => process.stderr.write('[lean] ' + a.join(' ') + '\n'),
  locateFile: (p) => `${INSTALL}/bin/${p}`,
  preRun: [
    function () {
      const FS = Module.FS;
      const NODEFS = Module.NODEFS;
      const ENV = Module.ENV || {};
      try { FS.mkdirTree('/Users'); } catch (e) {}
      try { FS.mount(NODEFS, { root: '/Users' }, '/Users'); } catch (e) {}
      ENV.LEAN_PATH = `${INSTALL}/lib/lean`;
      ENV.LEAN_SRC_PATH = `${INSTALL}/src/lean`;
      ENV.LEAN_SYSROOT = INSTALL;
      ENV.HOME = '/Users/' + (process.env.USER || 'user');
    },
  ],
};

const OLD = 'var Module=typeof Module!="undefined"?Module:{};';
const NEW = 'var Module=typeof globalThis!=="undefined"&&globalThis.Module?globalThis.Module:(typeof Module!="undefined"?Module:{});';
const src = fs.readFileSync(LEAN_JS, 'utf8');
if (!src.includes(OLD)) { console.error('[p1] pattern missing'); process.exit(2); }
const patched = src.replace(OLD, NEW);
const lm = new NodeModule(LEAN_JS, module);
lm.filename = LEAN_JS;
lm.paths = NodeModule._nodeModulePaths(path.dirname(LEAN_JS));
lm._compile(patched, LEAN_JS);
