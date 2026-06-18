// Milestone 1b-ii VALIDATION: does the return-path spawn patch fire?
//
// The new lean-jspi-pt build compiles process.cpp with the return-path
// patch: under __EMSCRIPTEN__, spawn() calls Module.__leanSpawnWorker(cmd,
// args); if it returns {pid>0, inFd, outFd, errFd}, the runtime builds the
// child object from those fds and RETURNS, skipping fork() (which ENOSYS'd
// → "error code 52").
//
// This smoke test stubs __leanSpawnWorker to hand back REAL MEMFS fds (not
// yet SAB-backed / not yet a real worker). The checkpoint:
//   1. NO "error code 52" — the fork bypass works.
//   2. The watchdog actually WRITES the `initialize` LSP frame into the
//      worker's stdin fd — proving the child object (parent_stdin writable)
//      is correctly constructed and the watchdog is driving "the worker".
//
// If both hold, the C++ side of Option A is DONE and all remaining work
// (SAB pipes + real worker) is rebuild-free JS.

const path = require('node:path');
const fs = require('node:fs');

// Instrument pthread Worker creation to catch worker crashes (the suspected
// cause of the spontaneous "onExit status=undefined").
const wt = require('node:worker_threads');
const _Worker = wt.Worker;
let workerSeq = 0;
class LoggedWorker extends _Worker {
  constructor(spec, opts) {
    const id = ++workerSeq;
    console.log('[smoke] >>> pthread Worker#' + id + ' spawned; execArgv=' +
      JSON.stringify((opts && opts.execArgv) || process.execArgv));
    super(spec, opts);
    this.on('error', (e) => console.error('[smoke] !!! Worker#' + id + ' ERROR: ' + (e && e.stack || e)));
    this.on('exit', (c) => console.log('[smoke] <<< Worker#' + id + ' exit code=' + c));
  }
}
wt.Worker = LoggedWorker;

const LEAN_ROOT = process.env.LEAN_BIN_DIR ||
  '/Users/nicholasbulka/prog/lean/wasm/build-wasm/stage1/bin';
const LEAN_JS = process.env.LEAN_JS || 'lean-jspi-pt.js';

const WORKER_STDIN = '/tmp/worker_stdin';   // watchdog writes worker's stdin here
const WORKER_STDOUT = '/tmp/worker_stdout'; // watchdog reads worker's stdout here

// === Async stdin queue (watchdog's OWN fd 0, client→watchdog) ===
const stdinByteQueue = [];
let pendingResolver = null;
function pushBytes(buf) {
  for (const b of buf) stdinByteQueue.push(b);
  if (pendingResolver) { const r = pendingResolver; pendingResolver = null; r(); }
}
async function readBytesAsync(maxCount) {
  while (stdinByteQueue.length === 0) {
    await new Promise((resolve) => { pendingResolver = resolve; });
  }
  const n = Math.min(maxCount, stdinByteQueue.length);
  return stdinByteQueue.splice(0, n);
}

// === LSP framing ===
function frameLsp(obj) {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
let nextId = 1;
function send(obj) {
  const buf = frameLsp(obj);
  pushBytes(buf);
  console.log('[smoke] →', obj.method ?? `id=${obj.id}`, '(', buf.length, 'bytes )');
}
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return id;
}
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

// === watchdog stdout receiver (client side) ===
const stdoutBytes = [];
function drainFrames() {
  while (true) {
    const buf = Buffer.from(stdoutBytes);
    const he = buf.indexOf(Buffer.from('\r\n\r\n', 'ascii'));
    if (he < 0) break;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, he).toString('ascii'));
    if (!m) { stdoutBytes.shift(); continue; }
    const len = parseInt(m[1], 10);
    const total = he + 4 + len;
    if (buf.length < total) break;
    let msg; try { msg = JSON.parse(buf.slice(he + 4, total).toString('utf8')); } catch (_) { msg = null; }
    stdoutBytes.splice(0, total);
    if (msg) console.log('[smoke] ←', JSON.stringify(msg).slice(0, 200));
  }
}

// === capture stderr for the error-52 check ===
let stderrText = '';
let spawnCalled = false;
let spawnArgs = null;

let fdReadCalls = 0;
globalThis.__leanFdReadOverride = function (origFdRead) {
  console.log('[smoke] fd_read override applied');
  return async function fd_read_async(fd, iov, iovcnt, pnum) {
    if (fd !== 0) {
      console.log('[smoke] fd_read fd=' + fd + ' (delegating to orig)');
      return origFdRead(fd, iov, iovcnt, pnum);
    }
    const call = ++fdReadCalls;
    let totalRead = 0;
    for (let i = 0; i < iovcnt; i++) {
      const H32 = new Uint32Array(global.Module.HEAPU8.buffer);
      const ptr = H32[iov >> 2]; const len = H32[(iov + 4) >> 2]; iov += 8;
      if (len === 0) continue;
      if (stdinByteQueue.length === 0) console.log('[smoke] fd_read#' + call + ' suspending (want ' + len + ')');
      const bytes = await readBytesAsync(len);
      const H8 = global.Module.HEAPU8;
      for (let j = 0; j < bytes.length; j++) H8[ptr + j] = bytes[j];
      totalRead += bytes.length;
      if (bytes.length < len) break;
    }
    new Uint32Array(global.Module.HEAPU8.buffer)[pnum >> 2] = totalRead;
    console.log('[smoke] fd_read#' + call + ' returned ' + totalRead + ' bytes');
    return 0;
  };
};

process.on('uncaughtException', (e) => { console.error('[smoke] UNCAUGHT:', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[smoke] UNHANDLED REJECTION:', e && e.stack || e); });

global.Module = {
  noInitialRun: true,
  stdin: () => null,
  stdout: (b) => { if (b != null) { stdoutBytes.push(b); drainFrames(); } },
  stderr: (b) => {
    if (b == null) return;
    const ch = String.fromCharCode(b);
    stderrText += ch;
    process.stderr.write(Buffer.from([b]));
  },
  onExit: (s) => console.log('[smoke] onExit status=' + s),
  onAbort: (w) => { console.error('[smoke] onAbort:', w); process.exit(3); },
  preRun: [function () {
    if (!global.Module.ENV) global.Module.ENV = {};
    global.Module.ENV.TZ = 'UTC';
    const FS = global.Module.FS;
    try { FS.mkdir('/etc'); } catch (_) {}
    try {
      const tz = require('fs').readFileSync('/etc/localtime');
      FS.writeFile('/etc/localtime', new Uint8Array(tz));
    } catch (e) { console.error('[smoke] localtime stub failed:', e.message); }
    // Pre-create the worker pipe files so fdopen(...,"r") can succeed.
    try { FS.writeFile(WORKER_STDIN, new Uint8Array(0)); } catch (_) {}
    try { FS.writeFile(WORKER_STDOUT, new Uint8Array(0)); } catch (_) {}
  }],
};

// THE HOOK UNDER TEST. Return real MEMFS fds + a fake pid.
global.Module.__leanSpawnWorker = function (cmd, args) {
  spawnCalled = true;
  spawnArgs = { cmd, args };
  console.log('[smoke] __leanSpawnWorker FIRED cmd=' + cmd + ' args=' + JSON.stringify(args));
  const FS = global.Module.FS;
  // inFd: watchdog WRITES worker's stdin here (fdopen "w").
  // outFd: watchdog READS worker's stdout here (fdopen "r").
  const inStream = FS.open(WORKER_STDIN, 'w');   // O_WRONLY|O_CREAT|O_TRUNC
  const outStream = FS.open(WORKER_STDOUT, 'r'); // O_RDONLY
  console.log('[smoke] returning inFd=' + inStream.fd + ' outFd=' + outStream.fd);
  return { pid: 424242, inFd: inStream.fd, outFd: outStream.fd, errFd: -1 };
};

const leanJsFull = path.join(LEAN_ROOT, LEAN_JS);
if (!fs.readFileSync(leanJsFull, 'utf8').startsWith('// LEAN_NODEFS_PATCHED')) {
  console.log('[smoke] patching NODEFS', leanJsFull);
  require('node:child_process').execFileSync(
    process.execPath, ['scripts/patch-leanjs.js', leanJsFull],
    { cwd: '/Users/nicholasbulka/prog/lean/wasm', stdio: 'inherit' });
}
if (!fs.readFileSync(leanJsFull, 'utf8').includes('JSPI_FD_READ_HOOK')) {
  console.log('[smoke] patching JSPI fd_read hook into', leanJsFull);
  require('node:child_process').execFileSync(
    process.execPath, ['scripts/patch-jspi-fdread.js', leanJsFull],
    { cwd: '/Users/nicholasbulka/prog/lean/wasm', stdio: 'inherit' });
}

require(leanJsFull);

(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[smoke] init timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[smoke] runtime ready after', waited, 'ms');

  console.log('[smoke] callMain(["--server"])…');
  const cm = global.Module.callMain(['--server']);
  if (cm && typeof cm.then === 'function') {
    cm.then((v) => console.log('[smoke] !! callMain promise RESOLVED value=' + v),
            (e) => console.log('[smoke] !! callMain promise REJECTED: name=' + (e && e.name) +
              ' status=' + (e && e.status) + ' msg=' + (e && e.message) +
              ' keys=' + (e ? JSON.stringify(Object.keys(e)) : e)));
  } else {
    console.log('[smoke] callMain returned (non-promise):', cm);
  }
  await new Promise((r) => setTimeout(r, 500));

  // Match the proven 1b-i driver: fire initialize → initialized → didOpen
  // back-to-back, with NO idle gap (the watchdog exits if left idle after
  // initialize). Send all three, then let fd_read deliver them in order.
  console.log('[smoke] initialize + initialized + didOpen (back-to-back)…');
  request('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  notify('initialized', {});
  const URI = 'inmemory:///main.lean';
  notify('textDocument/didOpen', {
    textDocument: { uri: URI, languageId: 'lean4', version: 1, text: 'def x : Nat := 42\n#eval x\n' },
  });

  // Give the watchdog time to spawn the "worker" and write to its stdin.
  await new Promise((r) => setTimeout(r, 3000));

  console.log('\n========== SMOKE RESULT ==========');
  console.log('__leanSpawnWorker called:', spawnCalled, spawnArgs ? JSON.stringify(spawnArgs) : '');
  const err52 = /error code: 52|errno 52|ENOSYS/.test(stderrText);
  console.log('error-52 / ENOSYS seen:', err52);

  // Did the watchdog write the worker's stdin?
  let workerStdin = Buffer.alloc(0);
  try { workerStdin = Buffer.from(global.Module.FS.readFile(WORKER_STDIN)); } catch (e) {
    console.log('[smoke] could not read worker stdin file:', e.message);
  }
  console.log('worker stdin bytes written by watchdog:', workerStdin.length);
  if (workerStdin.length) {
    console.log('worker stdin preview:', JSON.stringify(workerStdin.slice(0, 300).toString('utf8')));
  }
  const wroteInit = workerStdin.toString('utf8').includes('initialize');

  console.log('----------------------------------');
  if (spawnCalled && !err52 && wroteInit) {
    console.log('✓✓✓ RETURN-PATH WORKS: fork bypassed, watchdog drove the worker stdin.');
    process.exit(0);
  } else if (spawnCalled && !err52) {
    console.log('~ PARTIAL: spawn returned, fork bypassed, but no initialize in worker stdin yet.');
    process.exit(0);
  } else {
    console.log('✗ return-path did not take effect.');
    process.exit(1);
  }
})();
