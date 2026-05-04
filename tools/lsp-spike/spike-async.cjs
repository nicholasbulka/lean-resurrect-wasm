// Phase 11.0 follow-up: test continuous LSP against an Asyncify-built
// Lean WASM. With ASYNCIFY=1 (or JSPI), Module.stdin can return a
// Promise. The WASM read syscall suspends until the Promise resolves,
// during which time the JS event loop keeps spinning — so we can push
// bytes from main-thread async tasks without blocking ourselves.
//
// Usage:  BINARY_DIR=/path/to/built/bin node tools/lsp-spike/spike-async.cjs
//
// BINARY_DIR defaults to vendor/lean-linux_wasm32/bin (production
// build, NOT Asyncify) — for debugging, override to point at a fresh
// asyncify-flavoured build, e.g.
//   BINARY_DIR=$(pwd)/build-wasm/stage1/bin node ... \
//     tools/lsp-spike/spike-async.cjs
//
// SUCCESS = "✓ HOVER RESPONSE RECEIVED" with non-empty contents.

const path = require('node:path');

const LEAN_ROOT = process.env.BINARY_DIR ||
  '/Users/nicholasbulka/prog/lean/wasm/vendor/lean-linux_wasm32/bin';
const LEAN_JS = process.env.LEAN_JS || 'lean-asyncify.js';

console.log('[spike-async] loading', path.join(LEAN_ROOT, LEAN_JS));

// === Async stdin queue ===
// Module.stdin returns a Promise when no data is available. When we push
// bytes via sendBytes(), we resolve the pending promise.
let stdinByteQueue = [];           // pending bytes to feed Lean
let pendingResolver = null;        // current Module.stdin promise resolver

function readByteAsync() {
  if (stdinByteQueue.length > 0) return stdinByteQueue.shift();
  // No data — return a Promise. Asyncify suspends Lean until it resolves.
  return new Promise((resolve) => {
    pendingResolver = (b) => { resolve(b); };
  });
}

function sendBytes(buf) {
  for (const b of buf) stdinByteQueue.push(b);
  if (pendingResolver) {
    const r = pendingResolver;
    pendingResolver = null;
    // Hand off the next byte.
    r(stdinByteQueue.shift());
  }
}

// === Stdout framing ===
const stdoutBytes = [];
const messageHandlers = new Map();
function handleMessage(msg) {
  console.log('[spike-async] ←', JSON.stringify(msg).slice(0, 240));
  if (msg.id !== undefined && messageHandlers.has(msg.id)) {
    const r = messageHandlers.get(msg.id);
    messageHandlers.delete(msg.id);
    r(msg);
  }
}
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
    if (msg) handleMessage(msg);
  }
}

// === Module ===
global.Module = {
  noInitialRun: true,
  // ASYNCIFY allows Module.stdin to return a Promise.
  stdin: () => readByteAsync(),
  stdout: (b) => {
    if (b !== null && b !== undefined) {
      stdoutBytes.push(b);
      tryParseFrames();
    }
  },
  stderr: (b) => {
    if (b !== null && b !== undefined) process.stderr.write(Buffer.from([b]));
  },
  onExit: (status) => { console.log('[spike-async] onExit status=' + status); },
  onAbort: (what) => { console.error('[spike-async] onAbort:', what); process.exit(3); },
};

require(path.join(LEAN_ROOT, LEAN_JS));

// === LSP framing ===
function frameLsp(obj) {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
function send(obj) {
  const buf = frameLsp(obj);
  sendBytes(buf);
  console.log('[spike-async] →', obj.method ?? `id=${obj.id}`, '(', buf.length, 'bytes )');
}
function request(id, method, params) {
  return new Promise((resolve) => {
    messageHandlers.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// === Main ===
(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[spike-async] init timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[spike-async] runtime ready after', waited, 'ms');

  console.log('[spike-async] callMain(["--server"])…');
  global.Module.callMain(['--server']);

  await new Promise((r) => setTimeout(r, 500));

  console.log('[spike-async] sending initialize…');
  const t0 = Date.now();
  const initResp = await Promise.race([
    request(1, 'initialize', { processId: process.pid, rootUri: null, capabilities: {} }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('initialize timeout')), 60_000)),
  ]).catch((e) => { console.error('[spike-async]', e.message); return null; });
  if (!initResp) process.exit(1);
  console.log('[spike-async] ✓ initialize in', Date.now() - t0, 'ms');

  notify('initialized', {});

  const URI = 'inmemory:///main.lean';
  const SRC = 'def x : Nat := 42\n#eval x\n';
  notify('textDocument/didOpen', { textDocument: { uri: URI, languageId: 'lean4', version: 1, text: SRC } });

  await new Promise((r) => setTimeout(r, 1000));

  console.log('[spike-async] sending hover…');
  const tH = Date.now();
  const hover = await Promise.race([
    request(2, 'textDocument/hover', { textDocument: { uri: URI }, position: { line: 1, character: 6 } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('hover timeout')), 60_000)),
  ]).catch((e) => { console.error('[spike-async]', e.message); return null; });
  if (!hover) process.exit(1);
  console.log('[spike-async] hover in', Date.now() - tH, 'ms');
  console.log('[spike-async] hover.result =', JSON.stringify(hover.result).slice(0, 600));

  if (hover.result?.contents) {
    console.log('[spike-async] ✓ HOVER RESPONSE RECEIVED. Asyncify-LSP works.');
    process.exit(0);
  } else {
    console.log('[spike-async] hover empty — partial result, investigate.');
    process.exit(1);
  }
})();
