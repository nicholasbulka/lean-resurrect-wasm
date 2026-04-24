// Spike: does lean.wasm tolerate callMain() being invoked multiple times
// in a single Node process? If yes, we can build a warm worker pool that
// skips the ~30s WASM+olean cold start per request.
//
// Mechanism:
//   Module.noInitialRun = true    -> main() doesn't auto-run on load
//   Module.noExitRuntime = true   -> runtime stays alive after main returns
//   Module.callMain([args])       -> invoke main manually
// Then do callMain twice with --version. Second call should produce the
// version string just like the first.

const path = require('path');
const fs = require('fs');
const NodeModule = require('module');

const INSTALL = path.resolve(__dirname, '../vendor/lean-linux_wasm32');
const LEAN_JS = path.join(INSTALL, 'bin/lean.js');

process.on('unhandledRejection', (reason) => {
  console.error('[spike] unhandledRejection:', reason && reason.message);
  process.exit(42);
});
process.on('uncaughtException', (err) => {
  console.error('[spike] uncaughtException:', err && err.message);
  process.exit(43);
});

let runCount = 0;
const outputs = [];
let currentOut = '';

globalThis.Module = {
  arguments: ['--version'],
  thisProgram: `${INSTALL}/bin/lean`,
  noInitialRun: true,
  noExitRuntime: true,
  print: (msg) => { currentOut += msg + '\n'; },
  printErr: (msg) => { /* swallow stderr in spike */ },
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
  onRuntimeInitialized() {
    console.error('[spike] onRuntimeInitialized; about to run first callMain');
    run(['--version']);
    console.error('[spike] first run done, output len=', outputs[0]?.length);
    run(['--version']);
    console.error('[spike] second run done, output len=', outputs[1]?.length);
    run(['--help']);
    console.error('[spike] third run done (--help), output len=', outputs[2]?.length);
    console.log('=== runs ===');
    outputs.forEach((o, i) => console.log(`--- run ${i + 1} ---\n${o.slice(0, 200)}`));
    process.exit(0);
  },
};

function run(args) {
  runCount++;
  const t0 = Date.now();
  currentOut = '';
  const FS = Module.FS;
  const NODEFS = Module.NODEFS;
  // On subsequent runs, re-establish FS mounts and cwd. Lean's first main()
  // appears to dispose of things on its way out (chdir, fd state, etc.).
  if (runCount > 1) {
    // Re-open stdio fds (first main closes them).
    try { FS.streams[0] = FS.open('/dev/tty', 'r'); } catch (e) { console.error('reopen stdin:', e.message); }
    try { FS.streams[1] = FS.open('/dev/tty', 'w'); } catch (e) { console.error('reopen stdout:', e.message); }
    try { FS.streams[2] = FS.open('/dev/tty1', 'w'); } catch (e) { console.error('reopen stderr:', e.message); }
    try { FS.chdir('/'); } catch (e) {}
    // Re-mount if unmounted.
    try { FS.unmount('/Users'); } catch (e) {}
    try { FS.mkdirTree('/Users'); } catch (e) {}
    try { FS.mount(NODEFS, { root: '/Users' }, '/Users'); } catch (e) {}
  }
  try {
    const code = Module.callMain(args);
    const ms = Date.now() - t0;
    console.error(`[spike] callMain([${args.join(',')}]) returned ${code} in ${ms}ms`);
    outputs.push(currentOut);
  } catch (e) {
    console.error(`[spike] callMain threw:`, e && e.message, 'errno=', e && e.errno);
    outputs.push('(threw) ' + (e && e.message));
  }
}

const OLD_MOD = 'var Module=typeof Module!="undefined"?Module:{};';
const NEW_MOD = 'var Module=typeof globalThis!=="undefined"&&globalThis.Module?globalThis.Module:(typeof Module!="undefined"?Module:{});';
// callMain is a locally-scoped function in lean.js. Expose it on Module so
// we can invoke main() multiple times against the same loaded wasm.
const OLD_CM = 'var sharedModules=Module["sharedModules"]||[];';
const NEW_CM = 'Module.callMain=callMain;var sharedModules=Module["sharedModules"]||[];';
let src = fs.readFileSync(LEAN_JS, 'utf8');
if (!src.includes(OLD_MOD) || !src.includes(OLD_CM)) {
  console.error('[spike] one of the patch anchors is missing');
  process.exit(2);
}
src = src.replace(OLD_MOD, NEW_MOD).replace(OLD_CM, NEW_CM);
const lm = new NodeModule(LEAN_JS, module);
lm.filename = LEAN_JS;
lm.paths = NodeModule._nodeModulePaths(path.dirname(LEAN_JS));
lm._compile(src, LEAN_JS);
