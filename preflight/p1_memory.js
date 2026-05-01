#!/usr/bin/env node
// Preflight P1: peak HEAP8.length during a stdlib-heavy Lean compile.
//
// Gate: peak < 3 GiB.
//
// Reuses the patched lean.js (see scripts/patch-leanjs.js). Polls
// Module.HEAP8.length every 50ms while the compile runs. Logs peak on exit.

const path = require('path');
const fs = require('fs');

const INSTALL = fs.realpathSync(
  process.env.LEAN_INSTALL_DIR ||
    path.resolve(__dirname, '../vendor/lean-linux_wasm32')
);
const LEAN_JS = path.join(INSTALL, 'bin/lean.js');
const LEAN_FILE = process.argv[2] || path.join(__dirname, 'leantest/Linarith.lean');

if (!fs.readFileSync(LEAN_JS, 'utf8').startsWith('// LEAN_NODEFS_PATCHED')) {
  console.error('[p1] lean.js is not patched. Run: node scripts/patch-leanjs.js ' + LEAN_JS);
  process.exit(2);
}

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
  } catch (_) {}
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
  if (peakBytes >= gate) console.error('[p1] FAIL (>= 3 GiB)');
  else console.error('[p1] PASS (< 3 GiB)');
});

process.on('unhandledRejection', (reason) => {
  console.error('[p1] unhandledRejection:', reason && (reason.message || reason));
  process.exit(42);
});

globalThis.Module = {
  noInitialRun: true,
  print: (...a) => process.stdout.write(a.join(' ') + '\n'),
  printErr: (...a) => process.stderr.write('[lean] ' + a.join(' ') + '\n'),
  onExit: (status) => process.exit(status),
  preRun: [function () {
    const FS = Module.FS;
    if (!Module.ENV) Module.ENV = {};
    const ENV = Module.ENV;
    ENV.LEAN_PATH = path.join(INSTALL, 'lib/lean');
    ENV.LEAN_SRC_PATH = path.join(INSTALL, 'src/lean');
    ENV.LEAN_SYSROOT = INSTALL;
    ENV.HOME = '/Users/' + (process.env.USER || 'user');
    try {
      const cwd = fs.realpathSync(process.cwd());
      if (cwd !== INSTALL && !cwd.startsWith(INSTALL + '/')) {
        FS.mkdirTree(cwd);
        FS.mount(Module.NODEFS, { root: cwd }, cwd);
      }
    } catch (_) {}
  }],
};

require(LEAN_JS);

const wait = () => {
  if (!globalThis.Module.calledRun) { setTimeout(wait, 50); return; }
  globalThis.Module.callMain([LEAN_FILE]);
};
wait();
