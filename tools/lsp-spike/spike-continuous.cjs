// Phase 11a: continuous LSP I/O via SharedArrayBuffer + Atomics.wait.
//
// Replaces the spike.cjs pre-queue trick with a true blocking-stdin
// implementation: the pthread Lean runs on (under PROXY_TO_PTHREAD)
// blocks on Atomics.wait when the SAB ring buffer is empty, so Lean's
// LSP loop can do continuous read/write/read/write over the lifetime
// of the session.
//
// Test sequence:
//   1. boot lean.js, callMain(['--server'])
//   2. send initialize (no pre-queue — write *after* callMain)
//   3. send initialized notification
//   4. send textDocument/didOpen for inmemory:///main.lean
//   5. send textDocument/hover at the position of `x` in `#eval x`
//   6. expect a hover response with non-empty contents
//
// SUCCESS = "✓ HOVER RESPONSE RECEIVED" with non-empty contents.

const fs = require('fs');
const path = require('path');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/vendor/lean-linux_wasm32';

// === SharedArrayBuffer ring buffer for stdin ===
// Layout: [Int32Array(2): head, tail] [Uint8Array: ring]
// head: bytes consumed (incremented by pthread reader)
// tail: bytes produced (incremented by main writer)
// available = tail - head
// 64 KiB ring is comfortable for a few LSP frames in flight.
const RING_SIZE = 64 * 1024;
const stdinSab = new SharedArrayBuffer(8 + RING_SIZE);
const stdinIdx = new Int32Array(stdinSab, 0, 2); // [head, tail]
const stdinBuf = new Uint8Array(stdinSab, 8);

// pthread-side reader. This function is what Module.stdin calls; it
// runs inside the pthread Worker. When the buffer is empty, it blocks
// via Atomics.wait — which is allowed in Worker contexts (Node Worker
// Threads under PROXY_TO_PTHREAD are exactly that).
function readByteFromSab() {
  while (true) {
    const head = Atomics.load(stdinIdx, 0);
    const tail = Atomics.load(stdinIdx, 1);
    if (head < tail) {
      const b = stdinBuf[head % stdinBuf.length];
      Atomics.store(stdinIdx, 0, head + 1);
      return b;
    }
    // No data — block until producer notifies on tail. Pass `tail` as
    // the expected value so we only wait if it hasn't advanced since
    // we observed it (avoids missed notifications).
    Atomics.wait(stdinIdx, 1, tail);
  }
}

// main-side producer.
function pushBytes(bytes) {
  const len = bytes.length;
  const tail = Atomics.load(stdinIdx, 1);
  // Single-producer is fine; we don't need to CAS.
  if ((tail - Atomics.load(stdinIdx, 0)) + len > stdinBuf.length) {
    throw new Error('stdin ring overflow — bump RING_SIZE');
  }
  for (let i = 0; i < len; i++) {
    stdinBuf[(tail + i) % stdinBuf.length] = bytes[i];
  }
  Atomics.store(stdinIdx, 1, tail + len);
  Atomics.notify(stdinIdx, 1, 1);
}

// === LSP framing ===

const stdoutBytes = [];
const stderrBytes = [];

function frameLsp(obj) {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function sendLsp(obj) {
  const buf = frameLsp(obj);
  pushBytes(buf);
  console.log('[spike11a] →', obj.method ?? `id=${obj.id}`, '(', buf.length, 'bytes )');
}

function tryParseFrames() {
  const messages = [];
  while (true) {
    const buf = Buffer.from(stdoutBytes);
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n', 'ascii'));
    if (headerEnd < 0) break;
    const headerText = buf.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!m) {
      stdoutBytes.shift();
      continue;
    }
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (buf.length < total) break;
    const json = buf.slice(headerEnd + 4, total).toString('utf8');
    try { messages.push(JSON.parse(json)); }
    catch (e) { messages.push({ _parseError: e.message, raw: json }); }
    stdoutBytes.splice(0, total);
  }
  return messages;
}

// === Module setup ===
//
// Module.stdin / Module.stdout / Module.stderr are byte-level callbacks
// Emscripten's FS.init wires up. They run wherever Lean does its I/O —
// which under PROXY_TO_PTHREAD is the pthread, not the main thread.
//
// SharedArrayBuffer typed array views can be passed across threads
// implicitly because Emscripten's pthread setup serialises the Module
// object. The pthread re-creates Module from the main-thread copy, but
// SAB-backed Int32/Uint8 views referencing the same SAB are still
// pointing at the same shared memory (this is the whole point of SAB).

global.Module = {
  noInitialRun: true,
  stdin: () => readByteFromSab(),
  stdout: (b) => { if (b !== null && b !== undefined) stdoutBytes.push(b); },
  stderr: (b) => { if (b !== null && b !== undefined) stderrBytes.push(b); },
  onExit: (status) => { console.log('[spike11a] onExit status=' + status); },
  onAbort: (what) => { console.error('[spike11a] onAbort:', what); process.exit(3); },
  preRun: [function () {
    console.log('[spike11a] Module.preRun fired');
  }],
};

console.log('[spike11a] loading lean.js…');
require(path.join(LEAN_ROOT, 'bin', 'lean.js'));

(async function main() {
  // Wait for runtime.
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[spike11a] runtime init timed out'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[spike11a] runtime ready after', waited, 'ms');

  // Boot the LSP. With SAB-backed stdin, we DON'T need to pre-queue —
  // we can call --server and then write the first message after.
  console.log('[spike11a] callMain(["--server"])…');
  try { global.Module.callMain(['--server']); }
  catch (e) { console.error('[spike11a] callMain threw:', e); process.exit(4); }

  // Give the pthread a moment to spin up its reader.
  await new Promise((r) => setTimeout(r, 500));

  // 1. initialize
  sendLsp({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { processId: process.pid, rootUri: null, capabilities: {} },
  });

  // 2. wait for initialize response
  const initResp = await waitForId(1, 60_000);
  if (!initResp) { console.error('[spike11a] initialize timed out'); dumpAndExit(1); }
  console.log('[spike11a] ✓ initialize response received');

  // 3. initialized notification
  sendLsp({ jsonrpc: '2.0', method: 'initialized', params: {} });

  // 4. didOpen a small Lean source
  const FILE_URI = 'inmemory:///main.lean';
  const SOURCE = 'def x : Nat := 42\n#eval x\n';
  sendLsp({
    jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri: FILE_URI, languageId: 'lean4', version: 1, text: SOURCE } },
  });

  // 5. wait briefly for the server to start elaborating, then send hover.
  await new Promise((r) => setTimeout(r, 1000));

  // Position of `x` in `#eval x` (line 1, char 6 — 0-based)
  sendLsp({
    jsonrpc: '2.0', id: 2, method: 'textDocument/hover',
    params: { textDocument: { uri: FILE_URI }, position: { line: 1, character: 6 } },
  });

  // 6. await hover response.
  const hover = await waitForId(2, 60_000);
  if (!hover) { console.error('[spike11a] hover timed out'); dumpAndExit(1); }
  console.log('[spike11a] hover response:', JSON.stringify(hover).slice(0, 800));
  if (hover.result?.contents && JSON.stringify(hover.result.contents).length > 0) {
    console.log('[spike11a] ✓ HOVER RESPONSE RECEIVED with non-empty contents.');
    console.log('[spike11a] CONTINUOUS LSP IS REAL. Phase 11b can build on this.');
    process.exit(0);
  } else {
    console.log('[spike11a] hover returned but contents was empty/missing.');
    dumpAndExit(1);
  }
})();

// === Helpers ===

async function waitForId(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const messages = tryParseFrames();
    for (const m of messages) {
      console.log('[spike11a] ←', JSON.stringify(m).slice(0, 240));
      if (m.id === id) return m;
    }
    // Periodic stderr peek for diagnosis.
    const tickSec = Math.floor((timeoutMs - (deadline - Date.now())) / 1000);
    if (tickSec > 0 && tickSec % 5 === 0 && stderrBytes.length > 0) {
      const tail = Buffer.from(stderrBytes).toString('utf8').slice(-300);
      if (tail.trim()) console.log('[spike11a] stderr tail:', JSON.stringify(tail));
    }
  }
  return null;
}

function dumpAndExit(code) {
  console.log('[spike11a] final stdout pending:', stdoutBytes.length, 'bytes');
  if (stdoutBytes.length) console.log('[spike11a] stdout dump:', Buffer.from(stdoutBytes).toString('utf8').slice(0, 1000));
  if (stderrBytes.length) console.log('[spike11a] stderr dump:', Buffer.from(stderrBytes).toString('utf8').slice(-2000));
  process.exit(code);
}
