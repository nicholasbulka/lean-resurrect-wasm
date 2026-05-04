// Phase 11 spike: can lean --server run inside our Node WASM with
// custom Module.stdin / Module.stdout, talking LSP framing?
//
// Usage:  node --max-old-space-size=10240 tools/lsp-spike/spike.cjs
//
// Success: "[spike] received initialize response (id=1)" prints, with
//   the response JSON. That proves the libuv-stdin block is bypassable
//   via Emscripten Module hooks and Phase 11 (real LSP integration) is
//   real engineering work, not a research project.
//
// Failure modes to characterize (if they happen):
// - lean --server exits immediately with exit code N        → unsupported in our build
// - lean --server runs but never reads stdin                  → Module.stdin not consulted
// - lean --server reads stdin but never writes stdout         → output relay broken (same
//                                                                shape as the pthread-output
//                                                                block on browser-mode)
// - lean --server crashes during init                         → upstream bug, characterize

const fs = require('fs');
const path = require('path');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/vendor/lean-linux_wasm32';

// === I/O queues ===

/** Byte queue Lean reads from when it does read(0). null/undefined = EOF. */
const stdinQueue = [];
/** Bytes Lean has written to stdout, accumulated as a Buffer of int values. */
const stdoutBytes = [];
/** Bytes Lean has written to stderr. */
const stderrBytes = [];

function enqueueStdin(buf) {
  for (const b of buf) stdinQueue.push(b);
}

function sendLspMessage(obj) {
  const json = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
  enqueueStdin(Buffer.from(header, 'ascii'));
  enqueueStdin(Buffer.from(json, 'utf8'));
  console.log('[spike] →', obj.method ?? `id=${obj.id}`, '(', Buffer.byteLength(json, 'utf8'), 'bytes )');
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
      // Garbage before any LSP frame. Drop one byte and keep looking.
      stdoutBytes.shift();
      continue;
    }
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (buf.length < total) break;
    const json = buf.slice(headerEnd + 4, total).toString('utf8');
    try { messages.push(JSON.parse(json)); }
    catch (e) { messages.push({ _parseError: e.message, raw: json }); }
    // Drop the consumed bytes from the queue.
    stdoutBytes.splice(0, total);
  }
  return messages;
}

// === Module setup ===

global.Module = {
  noInitialRun: true,
  // FS.init reads these as byte-level callbacks for stdin/stdout/stderr.
  stdin: () => {
    const b = stdinQueue.shift();
    return b === undefined ? null : b;
  },
  stdout: (byte) => {
    if (byte === null || byte === undefined) return;
    stdoutBytes.push(byte);
  },
  stderr: (byte) => {
    if (byte === null || byte === undefined) return;
    stderrBytes.push(byte);
  },
  onExit: (status) => {
    console.log('[spike] onExit status=' + status);
  },
  onAbort: (what) => {
    console.error('[spike] onAbort:', what);
    process.exit(3);
  },
  // Print a startup heartbeat so we know module loaded.
  preRun: [function() {
    console.log('[spike] Module.preRun fired');
  }],
};

console.log('[spike] loading lean.js…');
require(path.join(LEAN_ROOT, 'bin', 'lean.js'));

(async function main() {
  // Wait for runtime init.
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[spike] runtime init timed out'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[spike] runtime ready (calledRun=true) after', waited, 'ms');

  // CRITICAL: pre-queue the initialize message BEFORE booting the LSP,
  // because Emscripten's synchronous Module.stdin returns null when the
  // queue is empty, which Lean interprets as EOF (stream closed). With
  // the message already in the queue, Lean reads it on its first stdin
  // read and never sees an empty-queue null.
  sendLspMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      clientInfo: { name: 'phase-11-spike', version: '0.1' },
    },
  });

  // Boot LSP server.
  console.log('[spike] callMain(["--server"])…');
  try { global.Module.callMain(['--server']); }
  catch (e) { console.error('[spike] callMain threw:', e); process.exit(4); }

  // Poll for responses.
  const startedAt = Date.now();
  const TIMEOUT_MS = 5 * 60_000;
  let receivedInit = false;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 1000));
    const messages = tryParseFrames();
    for (const m of messages) {
      console.log('[spike] ←', JSON.stringify(m).slice(0, 800));
      if (m.id === 1) receivedInit = true;
    }
    if (receivedInit) break;
    const tick = Math.floor((Date.now() - startedAt) / 1000);
    if (tick % 5 === 0) {
      console.log('[spike] tick', tick + 's',
        'stdin queue depth:', stdinQueue.length,
        'stdout bytes pending:', stdoutBytes.length,
        'stderr bytes pending:', stderrBytes.length);
      if (stderrBytes.length > 0) {
        const tail = Buffer.from(stderrBytes).toString('utf8').slice(-300);
        console.log('[spike] stderr tail:', JSON.stringify(tail));
      }
    }
  }

  if (receivedInit) {
    console.log('[spike] ✓ SUCCESS — initialize response received. LSP-via-WASM is real.');
    process.exit(0);
  } else {
    console.log('[spike] ✗ NO INITIALIZE RESPONSE');
    console.log('[spike] final stdoutBytes pending:', stdoutBytes.length);
    if (stdoutBytes.length) {
      console.log('[spike] stdout dump:', Buffer.from(stdoutBytes).toString('utf8').slice(0, 1000));
    }
    if (stderrBytes.length) {
      console.log('[spike] stderr dump:', Buffer.from(stderrBytes).toString('utf8').slice(-2000));
    }
    process.exit(1);
  }
})();
