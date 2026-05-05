// Phase 11.x: spike-streamops.cjs against the single-threaded JSPI
// build (lean-jspi-st.{js,wasm}). With pthread dropped and
// JSPI_EXPORTS=main, the WASM main runs directly on the main thread
// where the promising wrapper applies. Suspending-wrapped imports
// like __syscall_read should now actually suspend.

const path = require('node:path');
const fs = require('node:fs');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/build-wasm/stage1/bin';
const LEAN_JS = 'lean-jspi-st.js';

console.log('[spike-st] loading', path.join(LEAN_ROOT, LEAN_JS));

// === Async stdin queue ===
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
const messageHandlers = new Map();
let nextId = 1;
function send(obj) {
  const buf = frameLsp(obj);
  pushBytes(buf);
  console.log('[spike-st] →', obj.method ?? `id=${obj.id}`, '(', buf.length, 'bytes )');
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    messageHandlers.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

// === Stdout receiver ===
const stdoutBytes = [];
function tryParseFrames() {
  while (true) {
    const buf = Buffer.from(stdoutBytes);
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n', 'ascii'));
    if (headerEnd < 0) break;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, headerEnd).toString('ascii'));
    if (!m) { stdoutBytes.shift(); continue; }
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (buf.length < total) break;
    let msg;
    try { msg = JSON.parse(buf.slice(headerEnd + 4, total).toString('utf8')); }
    catch (_) { msg = null; }
    stdoutBytes.splice(0, total);
    if (msg) {
      console.log('[spike-st] ←', JSON.stringify(msg).slice(0, 240));
      if (msg.id !== undefined && messageHandlers.has(msg.id)) {
        const r = messageHandlers.get(msg.id);
        messageHandlers.delete(msg.id);
        r(msg);
      }
    }
  }
}

global.Module = {
  noInitialRun: true,
  stdin: () => null,
  stdout: (b) => { if (b !== null && b !== undefined) { stdoutBytes.push(b); tryParseFrames(); } },
  stderr: (b) => { if (b !== null && b !== undefined) process.stderr.write(Buffer.from([b])); },
  onExit: (status) => { console.log('[spike-st] onExit status=' + status); },
  onAbort: (what) => { console.error('[spike-st] onAbort:', what); process.exit(3); },
};

const leanJsFull = path.join(LEAN_ROOT, LEAN_JS);
if (!fs.readFileSync(leanJsFull, 'utf8').startsWith('// LEAN_NODEFS_PATCHED')) {
  console.log('[spike-st] patching', leanJsFull);
  require('node:child_process').execFileSync(
    process.execPath, ['scripts/patch-leanjs.js', leanJsFull],
    { cwd: '/Users/nicholasbulka/prog/lean/wasm', stdio: 'inherit' });
}

require(leanJsFull);

(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[spike-st] init timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[spike-st] runtime ready after', waited, 'ms');

  const FS = global.Module.FS;
  const stdin = FS.streams[0];
  if (!stdin) { console.error('[spike-st] FS.streams[0] missing'); process.exit(2); }
  const oldOps = stdin.stream_ops;

  let readCalls = 0;
  stdin.stream_ops = Object.assign({}, oldOps, {
    read(stream, buffer, offset, length, position) {
      const callId = ++readCalls;
      if (length === 0) {
        console.log('[spike-st] read #' + callId + ' length=0 (sync 0)');
        return 0;
      }
      console.log('[spike-st] read #' + callId + ' length=' + length + ' queue=' + stdinByteQueue.length);
      return (async () => {
        const bytes = await readBytesAsync(length);
        for (let i = 0; i < bytes.length; i++) buffer[offset + i] = bytes[i];
        console.log('[spike-st] read #' + callId + ' returning ' + bytes.length + ' bytes');
        return bytes.length;
      })();
    },
  });
  console.log('[spike-st] overrode FS.streams[0].stream_ops.read');

  console.log('[spike-st] callMain(["--server"])…');
  // With JSPI_EXPORTS=main, callMain may return a Promise. Don't
  // await it — the LSP loop runs continuously inside main, we drive
  // it from the outside via stdin/stdout.
  const callMainResult = global.Module.callMain(['--server']);
  console.log('[spike-st] callMain returned, type:', typeof callMainResult,
    callMainResult && typeof callMainResult.then === 'function' ? '(Promise)' : '');

  await new Promise((r) => setTimeout(r, 500));

  console.log('[spike-st] sending initialize…');
  const t0 = Date.now();
  let initResp;
  try {
    initResp = await Promise.race([
      request('initialize', { processId: process.pid, rootUri: null, capabilities: {} }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('initialize timeout')), 60_000)),
    ]);
  } catch (e) { console.error('[spike-st]', e.message); process.exit(1); }
  console.log('[spike-st] ✓ initialize in', Date.now() - t0, 'ms');

  notify('initialized', {});
  const URI = 'inmemory:///main.lean';
  notify('textDocument/didOpen', {
    textDocument: { uri: URI, languageId: 'lean4', version: 1, text: 'def x : Nat := 42\n#eval x\n' },
  });

  await new Promise((r) => setTimeout(r, 1000));

  console.log('[spike-st] sending hover…');
  const tH = Date.now();
  let hover;
  try {
    hover = await Promise.race([
      request('textDocument/hover', { textDocument: { uri: URI }, position: { line: 1, character: 6 } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('hover timeout')), 60_000)),
    ]);
  } catch (e) { console.error('[spike-st]', e.message); process.exit(1); }
  console.log('[spike-st] hover in', Date.now() - tH, 'ms');
  console.log('[spike-st] hover.result =', JSON.stringify(hover.result).slice(0, 600));

  if (hover.result?.contents) {
    console.log('[spike-st] ✓✓✓ HOVER RESPONSE RECEIVED. PHASE 11 FOUNDATION COMPLETE.');
    process.exit(0);
  } else {
    console.log('[spike-st] hover empty — investigate.');
    process.exit(1);
  }
})();
