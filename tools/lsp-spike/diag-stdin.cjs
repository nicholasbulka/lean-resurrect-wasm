// Diagnostic: where does Module.stdin get called from? Main thread or
// pthread? Logs each call, returns null (EOF) immediately so we don't
// block. Used to determine whether SAB+Atomics.wait can work where it
// is, or whether we need a different mechanism.

const path = require('path');
const wt = require('worker_threads');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/vendor/lean-linux_wasm32';

let stdinCalls = 0;

global.Module = {
  noInitialRun: true,
  stdin: () => {
    stdinCalls++;
    const where = wt.isMainThread ? 'MAIN' : 'PTHREAD';
    console.log(`[diag] Module.stdin call #${stdinCalls} from ${where} (worker name: ${wt.threadId})`);
    return null;  // EOF immediately
  },
  stdout: (b) => { /* swallow */ },
  stderr: (b) => { /* swallow */ },
  onExit: (status) => { console.log('[diag] onExit status=' + status); process.exit(0); },
  onAbort: (what) => { console.error('[diag] onAbort:', what); process.exit(3); },
};

console.log('[diag] worker_threads.isMainThread =', wt.isMainThread, 'threadId =', wt.threadId);
console.log('[diag] loading lean.js…');
require(path.join(LEAN_ROOT, 'bin', 'lean.js'));

(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[diag] init timed out'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[diag] runtime ready after', waited, 'ms');
  console.log('[diag] callMain(["--server"])…');
  global.Module.callMain(['--server']);

  // Wait 30s — see how many stdin calls happen and from where.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`[diag] tick ${i + 1}s — stdin calls so far: ${stdinCalls}`);
  }
  console.log('[diag] final stdin calls:', stdinCalls);
  process.exit(0);
})();
