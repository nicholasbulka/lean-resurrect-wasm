// Child process: runs Lean WASM in --server mode, with NO Module
// overrides. Emscripten's default Node tty handling reads from
// process.stdin and writes to process.stdout, so a real Unix pipe
// from the parent gives us full bidirectional LSP I/O for free.
//
// Spawned by spike-subprocess.cjs (and eventually by LspBridge in
// packages/tests/).

const path = require('path');
const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/vendor/lean-linux_wasm32';

global.Module = {
  noInitialRun: true,
  // No stdin/stdout/stderr overrides — let Emscripten's default node
  // tty handling pipe through process.stdin / process.stdout.
  onExit: (status) => { process.exit(status); },
  onAbort: (what) => {
    process.stderr.write('[lsp-runner] onAbort: ' + what + '\n');
    process.exit(3);
  },
};

require(path.join(LEAN_ROOT, 'bin', 'lean.js'));

(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { process.stderr.write('[lsp-runner] init timed out\n'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  process.stderr.write('[lsp-runner] runtime ready after ' + waited + 'ms\n');
  try { global.Module.callMain(['--server']); }
  catch (e) {
    process.stderr.write('[lsp-runner] callMain threw: ' + (e?.message ?? String(e)) + '\n');
    process.exit(4);
  }
})();
