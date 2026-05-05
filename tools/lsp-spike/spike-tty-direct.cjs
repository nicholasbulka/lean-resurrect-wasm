// Phase 11.1 / fix option 1: write LSP frames directly into the
// Emscripten TTY's input queue instead of going through Module.stdin.
// Lean's stdin reader pulls from `tty.input` via `tty.ops.get_char`;
// when input is non-empty, Module.stdin is never consulted, so the
// Promise-not-unwrapped issue from the prior spike doesn't apply.
//
// This proves continuous LSP (multi-message) works on the JSPI build,
// even with the simple synchronous TTY layer. The constraint is that
// every byte we want Lean to read must be enqueued BEFORE Lean tries
// to read past current tty.input. For batched flows (push all frames
// upfront, read all responses) this is fine; for true interactive
// (push frame, await response, push next based on response) we'd
// need to extend by either keeping tty.input topped up or by
// switching to a proper async syscall override (option 2 — needs
// access to imports object that this Emscripten version doesn't expose).
//
// Usage:
//   node --experimental-wasm-stack-switching --max-old-space-size=10240 \
//     tools/lsp-spike/spike-tty-direct.cjs

const path = require('node:path');
const fs = require('node:fs');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/build-wasm/stage1/bin';
const LEAN_JS = 'lean-jspi.js';

console.log('[spike-tty] loading', path.join(LEAN_ROOT, LEAN_JS));

// === LSP framing ===

function frameLsp(obj) {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

const INIT_REQ = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { processId: process.pid, rootUri: null, capabilities: {} } };
const INITIALIZED_NOTE = { jsonrpc: '2.0', method: 'initialized', params: {} };
const URI = 'inmemory:///main.lean';
const SRC = 'def x : Nat := 42\n#eval x\n';
const DIDOPEN_NOTE = { jsonrpc: '2.0', method: 'textDocument/didOpen',
  params: { textDocument: { uri: URI, languageId: 'lean4', version: 1, text: SRC } } };
const HOVER_REQ = { jsonrpc: '2.0', id: 2, method: 'textDocument/hover',
  params: { textDocument: { uri: URI }, position: { line: 1, character: 6 } } };

// Batch: all four messages back-to-back.
const BATCH = Buffer.concat([
  frameLsp(INIT_REQ),
  frameLsp(INITIALIZED_NOTE),
  frameLsp(DIDOPEN_NOTE),
  frameLsp(HOVER_REQ),
]);

// === Stdout receiver ===
const stdoutBytes = [];
const messageHandlers = new Map();
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
  console.log('[spike-tty] ←', JSON.stringify(msg).slice(0, 240));
  if (msg.id !== undefined && messageHandlers.has(msg.id)) {
    const r = messageHandlers.get(msg.id);
    messageHandlers.delete(msg.id);
    r(msg);
  }
}
function expectId(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    messageHandlers.set(id, resolve);
    setTimeout(() => {
      if (messageHandlers.has(id)) {
        messageHandlers.delete(id);
        reject(new Error(`timeout waiting for id=${id}`));
      }
    }, timeoutMs);
  });
}

// === Module setup ===

global.Module = {
  noInitialRun: true,
  // Module.stdin should not get called if tty.input stays populated.
  // We set it to return null as defensive EOF if Lean somehow drains
  // tty.input — the spike will just complete or fail visibly then.
  stdin: () => null,
  stdout: (b) => { if (b !== null && b !== undefined) { stdoutBytes.push(b); tryParseFrames(); } },
  stderr: (b) => { if (b !== null && b !== undefined) process.stderr.write(Buffer.from([b])); },
  onExit: (status) => { console.log('[spike-tty] onExit status=' + status); },
  onAbort: (what) => { console.error('[spike-tty] onAbort:', what); process.exit(3); },

};

function pushBatchToTty() {
  const FS = global.Module.FS;
  const stdin = FS && FS.streams && FS.streams[0];
  if (!stdin || !stdin.tty) {
    console.error('[spike-tty] FS.streams[0].tty still not available');
    return false;
  }
  console.log('[spike-tty] tty captured. existing tty.input.length=' + stdin.tty.input.length);
  for (const b of BATCH) stdin.tty.input.push(b);
  console.log('[spike-tty] queued', BATCH.length, 'bytes into tty.input. now length=' + stdin.tty.input.length);
  return true;
}

// Patch lean-jspi.js if not already.
const leanJsFull = path.join(LEAN_ROOT, LEAN_JS);
if (!fs.readFileSync(leanJsFull, 'utf8').startsWith('// LEAN_NODEFS_PATCHED')) {
  console.log('[spike-tty] patching', leanJsFull);
  require('node:child_process').execFileSync(
    process.execPath, ['scripts/patch-leanjs.js', leanJsFull],
    { cwd: '/Users/nicholasbulka/prog/lean/wasm', stdio: 'inherit' });
}

require(leanJsFull);

(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[spike-tty] init timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[spike-tty] runtime ready after', waited, 'ms');

  // Push batch BEFORE callMain so Lean's first stdin read sees the bytes.
  if (!pushBatchToTty()) { console.error('[spike-tty] could not queue stdin batch'); process.exit(2); }

  console.log('[spike-tty] callMain(["--server"])…');
  global.Module.callMain(['--server']);

  console.log('[spike-tty] awaiting initialize response…');
  const t0 = Date.now();
  let initResp;
  try { initResp = await expectId(1, 60_000); }
  catch (e) { console.error('[spike-tty]', e.message); process.exit(1); }
  console.log('[spike-tty] ✓ initialize response in', Date.now() - t0, 'ms');

  console.log('[spike-tty] awaiting hover response…');
  const tH = Date.now();
  let hover;
  try { hover = await expectId(2, 60_000); }
  catch (e) { console.error('[spike-tty]', e.message); process.exit(1); }
  console.log('[spike-tty] hover in', Date.now() - tH, 'ms');
  console.log('[spike-tty] hover.result =', JSON.stringify(hover.result).slice(0, 600));

  if (hover.result?.contents) {
    console.log('[spike-tty] ✓ HOVER RESPONSE RECEIVED. Continuous LSP via batched-TTY proven.');
    process.exit(0);
  } else {
    console.log('[spike-tty] hover empty — partial; investigate.');
    process.exit(1);
  }
})();
