// Phase 11a (subprocess flavour): spawn lsp-runner.cjs as a child
// process, talk to it via Unix pipes (the OS handles blocking I/O for
// us natively), drive a continuous LSP exchange.
//
// Test sequence:
//   1. spawn child
//   2. send initialize, receive response
//   3. send initialized notification
//   4. send textDocument/didOpen for a small Lean source
//   5. send textDocument/hover at the position of `x` in `#eval x`
//   6. expect a hover response with non-empty contents
//
// SUCCESS = "✓ HOVER RESPONSE RECEIVED" with non-empty contents.

const { spawn } = require('node:child_process');
const path = require('node:path');

const RUNNER = path.join(__dirname, 'lsp-runner.cjs');

const child = spawn('node', ['--max-old-space-size=10240', RUNNER], {
  cwd: path.join(__dirname, '..', '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
});

// === Frame parsing on stdout ===

let stdoutBuf = Buffer.alloc(0);
const messageHandlers = new Map();           // id -> {resolve, reject}
const notificationHandlers = [];             // [(method, params) => void]

child.stdout.on('data', (chunk) => {
  stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
  while (true) {
    const headerEnd = stdoutBuf.indexOf(Buffer.from('\r\n\r\n', 'ascii'));
    if (headerEnd < 0) break;
    const headerText = stdoutBuf.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!m) {
      // garbage — drop a byte and re-scan
      stdoutBuf = stdoutBuf.slice(1);
      continue;
    }
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (stdoutBuf.length < total) break;
    const json = stdoutBuf.slice(headerEnd + 4, total).toString('utf8');
    stdoutBuf = stdoutBuf.slice(total);
    let msg;
    try { msg = JSON.parse(json); }
    catch (e) { console.error('[spike-sub] parse error:', e.message, json.slice(0, 200)); continue; }
    console.log('[spike-sub] ←', JSON.stringify(msg).slice(0, 240));
    if (msg.id !== undefined && messageHandlers.has(msg.id)) {
      const { resolve } = messageHandlers.get(msg.id);
      messageHandlers.delete(msg.id);
      resolve(msg);
    } else if (msg.method) {
      for (const h of notificationHandlers) h(msg.method, msg.params);
    }
  }
});

child.stderr.on('data', (chunk) => {
  process.stderr.write('[child] ' + chunk.toString('utf8'));
});

child.on('exit', (code) => {
  console.log('[spike-sub] child exited with code', code);
  for (const { reject } of messageHandlers.values()) reject(new Error('child exited'));
  process.exit(code ?? 0);
});

// === LSP framing on stdin ===

function frameLsp(obj) {
  const json = JSON.stringify(obj);
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function send(obj) {
  const buf = frameLsp(obj);
  child.stdin.write(buf);
  console.log('[spike-sub] →', obj.method ?? `id=${obj.id}`, '(', buf.length, 'bytes )');
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    messageHandlers.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// === Main flow ===

(async () => {
  console.log('[spike-sub] waiting for child to be ready (look for runtime-ready msg in stderr)…');
  // We don't have a synchronous ready signal, but the runtime takes
  // ~5-7s. We just let the LSP server startup happen and rely on Lean
  // queueing our initialize message until ready.
  await new Promise((r) => setTimeout(r, 500));

  console.log('[spike-sub] sending initialize…');
  const initStart = Date.now();
  const initResp = await Promise.race([
    request(1, 'initialize', { processId: process.pid, rootUri: null, capabilities: {} }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('initialize timeout')), 60_000)),
  ]).catch((e) => { console.error('[spike-sub]', e.message); return null; });
  if (!initResp) { child.kill(); process.exit(1); }
  console.log('[spike-sub] ✓ initialize response received in', Date.now() - initStart, 'ms');

  notify('initialized', {});

  const FILE_URI = 'inmemory:///main.lean';
  const SOURCE = 'def x : Nat := 42\n#eval x\n';
  notify('textDocument/didOpen', {
    textDocument: { uri: FILE_URI, languageId: 'lean4', version: 1, text: SOURCE },
  });

  await new Promise((r) => setTimeout(r, 1000));

  console.log('[spike-sub] sending textDocument/hover…');
  const hoverStart = Date.now();
  const hover = await Promise.race([
    request(2, 'textDocument/hover', {
      textDocument: { uri: FILE_URI },
      position: { line: 1, character: 6 },     // `x` in `#eval x`
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('hover timeout')), 60_000)),
  ]).catch((e) => { console.error('[spike-sub]', e.message); return null; });

  if (!hover) { child.kill(); process.exit(1); }

  console.log('[spike-sub] hover took', Date.now() - hoverStart, 'ms');
  console.log('[spike-sub] hover.result =', JSON.stringify(hover.result).slice(0, 800));

  if (hover.result?.contents) {
    console.log('[spike-sub] ✓ HOVER RESPONSE RECEIVED. CONTINUOUS LSP IS REAL.');
    child.kill();
    process.exit(0);
  } else {
    console.log('[spike-sub] hover returned but contents was empty — partial success, investigate.');
    child.kill();
    process.exit(1);
  }
})();
