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

// ===== 1b-iii PROBE: device-backed fds + execution-model discovery =====
// Goal: learn HOW the watchdog touches the worker's stdin/stdout fds.
//   - Does a custom FS device's stream_ops intercept reads/writes on inFd/outFd?
//   - On which thread (ENVIRONMENT_IS_PTHREAD) do those ops run?
//   - Can that thread block on Atomics.wait (needed for a SAB-backed outFd read)?
// No real worker yet: inFd writes are captured; outFd reads block briefly on an
// (empty) SAB then return EOF, so we just observe the thread/intercept model.

// Minimal SAB ring pipe (inlined; sab-pipe.mjs is ESM).
const HEAD = 0, TAIL = 1, CLOSED = 2;
function makePipe(cap = 1 << 20) {
  return { ctrl: new Int32Array(new SharedArrayBuffer(12)), data: new Uint8Array(new SharedArrayBuffer(cap)), cap };
}
function pipeWrite(p, bytes, off, len) {
  let w = 0;
  while (w < len) {
    const head = Atomics.load(p.ctrl, HEAD), tail = Atomics.load(p.ctrl, TAIL);
    const free = p.cap - (tail - head);
    if (free === 0) { Atomics.wait(p.ctrl, HEAD, head); continue; }
    const n = Math.min(free, len - w);
    for (let i = 0; i < n; i++) p.data[(tail + i) % p.cap] = bytes[off + w + i];
    Atomics.store(p.ctrl, TAIL, tail + n); Atomics.notify(p.ctrl, TAIL); w += n;
  }
  return w;
}
// Blocking read with a timeout (ms). Returns Uint8Array (len 0 = timeout/EOF).
function pipeReadBlocking(p, max, timeoutMs) {
  const head = Atomics.load(p.ctrl, HEAD), tail = Atomics.load(p.ctrl, TAIL);
  const avail = tail - head;
  if (avail > 0) {
    const n = Math.min(avail, max), out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = p.data[(head + i) % p.cap];
    Atomics.store(p.ctrl, HEAD, head + n); Atomics.notify(p.ctrl, HEAD);
    return out;
  }
  if (Atomics.load(p.ctrl, CLOSED)) return new Uint8Array(0);
  Atomics.wait(p.ctrl, TAIL, tail, timeoutMs); // may throw on main thread
  const t2 = Atomics.load(p.ctrl, TAIL), a2 = t2 - head;
  if (a2 <= 0) return new Uint8Array(0);
  const n = Math.min(a2, max), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = p.data[(head + i) % p.cap];
  Atomics.store(p.ctrl, HEAD, head + n); Atomics.notify(p.ctrl, HEAD);
  return out;
}

let pipeToWorker = null;    // watchdog → worker (worker stdin)
let pipeFromWorker = null;  // worker → watchdog (worker stdout)
const probeLog = [];        // {op, fd, thread, len, note}
function plog(rec) { probeLog.push(rec); console.log('[probe] ' + JSON.stringify(rec)); }
function isPthread() { try { return !!global.ENVIRONMENT_IS_PTHREAD; } catch (_) { return 'unknown'; } }

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
    // Register a custom char device whose stream_ops drive the SAB pipes,
    // logging the thread/intercept model on every read/write.
    const dev = FS.makedev(99, 0);
    FS.registerDevice(dev, {
      open(stream) { plog({ op: 'dev.open', fd: stream.fd, thread: isPthread() }); },
      close() {},
      // buffer: HEAP Uint8Array; write [offset, offset+length) to the worker's stdin.
      write(stream, buffer, offset, length /*, pos */) {
        const isIn = stream.node === inNode;
        plog({ op: 'dev.write', node: isIn ? 'inFd' : 'outFd', fd: stream.fd, thread: isPthread(), len: length });
        if (isIn && pipeToWorker) return pipeWrite(pipeToWorker, buffer, offset, length);
        return length; // swallow
      },
      // read into buffer[offset..]; deliver worker stdout (blocking up to 2.5s).
      read(stream, buffer, offset, length /*, pos */) {
        const isOut = stream.node === outNode;
        let threw = null, n = 0;
        try {
          if (isOut && pipeFromWorker) {
            const got = pipeReadBlocking(pipeFromWorker, length, 2500);
            for (let i = 0; i < got.length; i++) buffer[offset + i] = got[i];
            n = got.length;
          }
        } catch (e) { threw = String(e && e.message || e); }
        plog({ op: 'dev.read', node: isOut ? 'outFd' : 'inFd', fd: stream.fd, thread: isPthread(), want: length, got: n, threw });
        return n; // 0 => EOF
      },
      llseek() { throw new FS.ErrnoError(70 /*ESPIPE*/); },
    });
    FS.mkdev('/dev/leanin', dev);
    FS.mkdev('/dev/leanout', dev);
    global.__probeDev = dev;
  }],
};

let inNode = null, outNode = null;

// THE HOOK UNDER TEST (device-backed). Return char-device fds + a fake pid.
global.Module.__leanSpawnWorker = function (cmd, args) {
  spawnCalled = true;
  spawnArgs = { cmd, args };
  console.log('[probe] __leanSpawnWorker FIRED thread=' + isPthread() + ' cmd=' + cmd + ' args=' + JSON.stringify(args));
  pipeToWorker = makePipe();
  pipeFromWorker = makePipe();
  const FS = global.Module.FS;
  const inStream = FS.open('/dev/leanin', 'w');   // watchdog writes worker stdin
  const outStream = FS.open('/dev/leanout', 'r'); // watchdog reads worker stdout
  inNode = inStream.node; outNode = outStream.node;
  console.log('[probe] returning inFd=' + inStream.fd + ' outFd=' + outStream.fd);

  // 1b-iii.a: launch the FAKE worker thread, bound to the other ends of the SABs.
  const fw = new _Worker(path.join(__dirname, 'fake-worker.cjs'), {
    workerData: {
      toWorker:   { ctrl: pipeToWorker.ctrl.buffer,   data: pipeToWorker.data.buffer,   cap: pipeToWorker.cap },
      fromWorker: { ctrl: pipeFromWorker.ctrl.buffer, data: pipeFromWorker.data.buffer, cap: pipeFromWorker.cap },
    },
  });
  fw.on('message', (m) => console.log('[fakeworker] ' + JSON.stringify(m)));
  fw.on('error', (e) => console.error('[fakeworker] ERROR ' + (e && e.stack || e)));
  fw.on('exit', (c) => console.log('[fakeworker] exit code=' + c));
  global.__fakeWorker = fw;

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

  // Let the watchdog drive the device fds (write stdin, attempt to read stdout).
  await new Promise((r) => setTimeout(r, 6000));

  console.log('\n========== PROBE RESULT ==========');
  console.log('__leanSpawnWorker called:', spawnCalled, '(thread=' + (spawnArgs ? isPthread() : 'n/a') + ')');
  const writes = probeLog.filter((r) => r.op === 'dev.write');
  const reads = probeLog.filter((r) => r.op === 'dev.read');
  // What did the watchdog write into the worker's stdin pipe? (drain pipeToWorker)
  let inBytes = 0;
  if (pipeToWorker) {
    const head = Atomics.load(pipeToWorker.ctrl, HEAD), tail = Atomics.load(pipeToWorker.ctrl, TAIL);
    inBytes = tail - head;
  }
  console.log('dev.write calls:', writes.length, '| dev.read calls:', reads.length);
  console.log('inFd device intercepted writes?', writes.some((r) => r.node === 'inFd'),
              '| bytes queued to worker stdin:', inBytes);
  console.log('outFd device intercepted reads? ', reads.some((r) => r.node === 'outFd'));
  const readThreads = [...new Set(reads.map((r) => r.thread))];
  const writeThreads = [...new Set(writes.map((r) => r.thread))];
  console.log('write thread(s):', JSON.stringify(writeThreads), '| read thread(s):', JSON.stringify(readThreads));
  const readThrew = reads.find((r) => r.threw);
  console.log('Atomics.wait threw in dev.read?', readThrew ? readThrew.threw : false);
  console.log('----------------------------------');
  console.log('VERDICT:');
  console.log('  inFd  via FS device :', writes.some((r) => r.node === 'inFd') ? 'YES' : 'NO');
  console.log('  outFd via FS device :', reads.some((r) => r.node === 'outFd') ? 'YES' : 'NO');
  console.log('  outFd read blockable:', reads.some((r) => r.node === 'outFd') && !readThrew ? 'YES (Atomics.wait ok on that thread)'
              : readThrew ? 'NO (Atomics.wait threw — main thread)' : 'UNKNOWN (no outFd read seen)');
  process.exit(0);
})();
