// Phase 11.1 / fix option 2: override __syscall_read at the WASM-JS
// import boundary so Promise-returning JS functions actually propagate
// through the JSPI suspension wrapper.
//
// The previous spike (spike-async.cjs) showed that returning a Promise
// from Module.stdin doesn't work because Emscripten's TTY layer is
// sync — it treats the Promise as iterable, pushes undefined into
// tty.input, garbage bytes get returned to Lean.
//
// JSPI auto-wraps imports at the WASM-JS boundary. When an imported
// function returns a Promise, JSPI suspends the WASM. The fix is to
// replace __syscall_read directly so its Promise return reaches the
// JSPI wrapper, instead of going through the layered TTY code.
//
// Usage:
//   node --experimental-wasm-stack-switching --max-old-space-size=10240 \
//     tools/lsp-spike/spike-jspi-syscall.cjs

const path = require('node:path');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/build-wasm/stage1/bin';
const LEAN_JS = 'lean-jspi.js';

console.log('[spike-syscall] loading', path.join(LEAN_ROOT, LEAN_JS));

// === Async stdin queue (main-thread side) ===
const stdinByteQueue = [];
let pendingResolver = null;

async function readBytesAsync(count) {
  // Wait until we have at least one byte (LSP read can return short).
  while (stdinByteQueue.length === 0) {
    await new Promise((resolve) => { pendingResolver = resolve; });
  }
  // Return up to `count` bytes that are immediately available.
  const n = Math.min(count, stdinByteQueue.length);
  const out = stdinByteQueue.splice(0, n);
  return out;
}

function pushBytes(buf) {
  for (const b of buf) stdinByteQueue.push(b);
  if (pendingResolver) {
    const r = pendingResolver;
    pendingResolver = null;
    r();
  }
}

// === LSP framing (sender) ===
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
  console.log('[spike-syscall] →', obj.method ?? `id=${obj.id}`, '(', buf.length, 'bytes )');
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    messageHandlers.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// === LSP framing (receiver) — buffer stdout, parse complete frames ===
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
    if (msg) handleMessage(msg);
  }
}
function handleMessage(msg) {
  console.log('[spike-syscall] ←', JSON.stringify(msg).slice(0, 240));
  if (msg.id !== undefined && messageHandlers.has(msg.id)) {
    const r = messageHandlers.get(msg.id);
    messageHandlers.delete(msg.id);
    r(msg);
  }
}

// === Module setup ===

global.Module = {
  noInitialRun: true,
  // We DO NOT use Module.stdin — overriding __syscall_read directly
  // bypasses Emscripten's TTY layer entirely.
  stdout: (b) => {
    if (b !== null && b !== undefined) {
      stdoutBytes.push(b);
      tryParseFrames();
    }
  },
  stderr: (b) => {
    if (b !== null && b !== undefined) process.stderr.write(Buffer.from([b]));
  },
  onExit: (status) => { console.log('[spike-syscall] onExit status=' + status); },
  onAbort: (what) => { console.error('[spike-syscall] onAbort:', what); process.exit(3); },

  // KEY HOOK: instrumentWasmImports runs after Emscripten constructs
  // the imports object but before the WASM module is instantiated.
  // We replace __syscall_read with an async version that handles fd 0
  // (stdin) via our queue, and delegates other fds to the original.
  // JSPI auto-wraps async imports — a Promise return suspends WASM
  // execution until the Promise resolves.
  instrumentWasmImports(imports) {
    console.log('[spike-syscall] instrumentWasmImports called');
    // Try common syscall names — Emscripten's name varies by version.
    const env = imports.env || imports;
    let originalRead = null;
    let overrideKey = null;
    for (const key of ['__syscall_read', 'fd_read', 'env.__syscall_read']) {
      if (typeof env[key] === 'function') {
        originalRead = env[key];
        overrideKey = key;
        break;
      }
    }
    if (!originalRead) {
      console.log('[spike-syscall] WARN — no __syscall_read in imports. Keys:',
        Object.keys(env).filter((k) => k.includes('read')).slice(0, 10));
      return;
    }
    console.log('[spike-syscall] overriding', overrideKey);
    env[overrideKey] = async function syscallRead(fd, buf, count) {
      if (fd !== 0) {
        return originalRead.apply(this, arguments);
      }
      // stdin (fd 0) — read from async queue.
      const bytes = await readBytesAsync(count);
      const heap = new Uint8Array(global.Module.HEAPU8.buffer);
      for (let i = 0; i < bytes.length; i++) heap[buf + i] = bytes[i];
      return bytes.length;
    };
  },
};

// Patch lean-jspi.js if not already.
const fs = require('fs');
const leanJsFull = path.join(LEAN_ROOT, LEAN_JS);
if (!fs.readFileSync(leanJsFull, 'utf8').startsWith('// LEAN_NODEFS_PATCHED')) {
  console.log('[spike-syscall] patching', leanJsFull);
  require('child_process').execFileSync(
    process.execPath, ['scripts/patch-leanjs.js', leanJsFull], { cwd: '/Users/nicholasbulka/prog/lean/wasm', stdio: 'inherit' });
}

require(leanJsFull);

(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[spike-syscall] init timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[spike-syscall] runtime ready after', waited, 'ms');

  console.log('[spike-syscall] callMain(["--server"])…');
  global.Module.callMain(['--server']);

  await new Promise((r) => setTimeout(r, 500));

  // 1. initialize
  console.log('[spike-syscall] sending initialize…');
  const t0 = Date.now();
  const initResp = await Promise.race([
    request('initialize', { processId: process.pid, rootUri: null, capabilities: {} }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('initialize timeout')), 60_000)),
  ]).catch((e) => { console.error('[spike-syscall]', e.message); return null; });
  if (!initResp) process.exit(1);
  console.log('[spike-syscall] ✓ initialize in', Date.now() - t0, 'ms');

  // 2. initialized + didOpen
  notify('initialized', {});
  const URI = 'inmemory:///main.lean';
  const SRC = 'def x : Nat := 42\n#eval x\n';
  notify('textDocument/didOpen', {
    textDocument: { uri: URI, languageId: 'lean4', version: 1, text: SRC },
  });

  await new Promise((r) => setTimeout(r, 1000));

  // 3. hover
  console.log('[spike-syscall] sending textDocument/hover…');
  const tH = Date.now();
  const hover = await Promise.race([
    request('textDocument/hover', { textDocument: { uri: URI }, position: { line: 1, character: 6 } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('hover timeout')), 60_000)),
  ]).catch((e) => { console.error('[spike-syscall]', e.message); return null; });

  if (!hover) process.exit(1);
  console.log('[spike-syscall] hover in', Date.now() - tH, 'ms');
  console.log('[spike-syscall] hover.result =', JSON.stringify(hover.result).slice(0, 600));

  if (hover.result?.contents) {
    console.log('[spike-syscall] ✓ HOVER RESPONSE RECEIVED. CONTINUOUS LSP IS REAL.');
    process.exit(0);
  } else {
    console.log('[spike-syscall] hover empty — partial; investigate.');
    process.exit(1);
  }
})();
