// 1b-iii.a: a FAKE Lean worker (pure JS, no wasm) running in a worker_thread.
// It stands in for `lean --worker` to prove the watchdog↔worker SAB pipe works
// end-to-end on real threads: it reads LSP frames the watchdog writes to the
// worker's stdin (pipeToWorker) and writes minimal LSP replies to the worker's
// stdout (pipeFromWorker). If the watchdog accepts the `initialize` reply and
// stops dying with "Stream was closed", the bidirectional pipe is proven.
//
// Run indirectly: spawned by spike-probe-fds.cjs via new Worker(...). The two
// SABs arrive in workerData as raw SharedArrayBuffers.

const { workerData, parentPort } = require('node:worker_threads');

const HEAD = 0, TAIL = 1, CLOSED = 2;
function mkPipe({ ctrl, data, cap }) { return { c: new Int32Array(ctrl), d: new Uint8Array(data), cap }; }
const toW = mkPipe(workerData.toWorker);     // watchdog → worker (our stdin)
const fromW = mkPipe(workerData.fromWorker); // worker → watchdog (our stdout)

function readByteBlocking() {
  for (;;) {
    const head = Atomics.load(toW.c, HEAD), tail = Atomics.load(toW.c, TAIL);
    if (tail - head > 0) {
      const b = toW.d[head % toW.cap];
      Atomics.store(toW.c, HEAD, head + 1); Atomics.notify(toW.c, HEAD);
      return b;
    }
    if (Atomics.load(toW.c, CLOSED)) return -1;
    Atomics.wait(toW.c, TAIL, tail);
  }
}
function writeBytes(buf) {
  let off = 0;
  while (off < buf.length) {
    const head = Atomics.load(fromW.c, HEAD), tail = Atomics.load(fromW.c, TAIL);
    const free = fromW.cap - (tail - head);
    if (free === 0) { Atomics.wait(fromW.c, HEAD, head); continue; }
    const n = Math.min(free, buf.length - off);
    for (let i = 0; i < n; i++) fromW.d[(tail + i) % fromW.cap] = buf[off + i];
    Atomics.store(fromW.c, TAIL, tail + n); Atomics.notify(fromW.c, TAIL);
    off += n;
  }
}
function sendLsp(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  writeBytes(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'));
  writeBytes(body);
  parentPort.postMessage({ kind: 'sent', method: obj.method, id: obj.id });
}

// Parse one LSP frame (Content-Length framing) from the byte stream.
function readFrame() {
  const header = [];
  // read until \r\n\r\n
  for (;;) {
    const b = readByteBlocking();
    if (b < 0) return null;
    header.push(b);
    const L = header.length;
    if (L >= 4 && header[L - 4] === 13 && header[L - 3] === 10 && header[L - 2] === 13 && header[L - 1] === 10) break;
  }
  const headStr = Buffer.from(header).toString('ascii');
  const m = /Content-Length:\s*(\d+)/i.exec(headStr);
  if (!m) return null;
  const len = parseInt(m[1], 10);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) { const b = readByteBlocking(); if (b < 0) return null; body[i] = b; }
  try { return JSON.parse(body.toString('utf8')); } catch (_) { return null; }
}

parentPort.postMessage({ kind: 'ready' });

for (;;) {
  const msg = readFrame();
  if (msg === null) { parentPort.postMessage({ kind: 'eof' }); break; }
  parentPort.postMessage({ kind: 'recv', method: msg.method, id: msg.id });
  if (msg.id !== undefined && msg.method) {
    // It's a request — answer it.
    if (msg.method === 'initialize') {
      sendLsp({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
    } else if (msg.method === 'textDocument/hover') {
      sendLsp({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'plaintext', value: 'FAKE-WORKER-HOVER-OK' } } });
    } else {
      sendLsp({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  }
  // notifications (initialized, didOpen, ...) are accepted silently
}
