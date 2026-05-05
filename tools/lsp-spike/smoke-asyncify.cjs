// Quick smoke: does the asyncify-built lean.wasm boot and answer --version?
//
// Usage: BINARY_DIR=$(pwd)/build-wasm/stage1/bin node tools/lsp-spike/smoke-asyncify.cjs

const path = require('node:path');

const LEAN_ROOT = process.env.BINARY_DIR ||
  '/Users/nicholasbulka/prog/lean/wasm/build-wasm/stage1/bin';
const LEAN_JS = process.env.LEAN_JS || 'lean-asyncify.js';

console.log('[smoke] loading', path.join(LEAN_ROOT, LEAN_JS));

let stdoutBuf = '';
let stderrBuf = '';

global.Module = {
  noInitialRun: true,
  print: (text) => { stdoutBuf += text + '\n'; },
  printErr: (text) => { stderrBuf += text + '\n'; },
  onExit: (status) => {
    console.log('[smoke] exit status:', status);
    console.log('[smoke] STDOUT:');
    console.log(stdoutBuf);
    if (stderrBuf) {
      console.log('[smoke] STDERR:');
      console.log(stderrBuf.slice(-2000));
    }
    process.exit(status);
  },
  onAbort: (what) => {
    console.error('[smoke] onAbort:', what);
    if (stderrBuf) console.error('[smoke] STDERR before abort:\n' + stderrBuf.slice(-2000));
    process.exit(3);
  },
};

require(path.join(LEAN_ROOT, LEAN_JS));

(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[smoke] init timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[smoke] runtime ready after', waited, 'ms');
  console.log('[smoke] callMain(["--version"])…');
  global.Module.callMain(['--version']);
  // onExit will be called and print results.
  // Safety timeout in case it doesn't:
  setTimeout(() => {
    console.log('[smoke] no exit after 30s — STDOUT:', stdoutBuf, 'STDERR:', stderrBuf.slice(-1000));
    process.exit(99);
  }, 30000);
})();
