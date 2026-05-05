// Phase 11.x: replace `fd_read` at the WASM imports object BEFORE
// Asyncify.instrumentWasmImports wraps it with Suspending. Then the
// Asyncify wrapper sits on top of OUR async function, so Promise
// returns propagate cleanly through the JSPI suspension layer.
//
// Bypasses: doReadv → FS.read → stream_ops.read entirely. We
// implement fd_read ourselves with direct HEAP writes.

const path = require('node:path');
const fs = require('node:fs');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/build-wasm/stage1/bin';
const LEAN_JS = 'lean-jspi-st.js';

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
  console.log('[fdread] →', obj.method ?? `id=${obj.id}`, '(', buf.length, 'bytes )');
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
      console.log('[fdread] ←', JSON.stringify(msg).slice(0, 240));
      if (msg.id !== undefined && messageHandlers.has(msg.id)) {
        const r = messageHandlers.get(msg.id);
        messageHandlers.delete(msg.id);
        r(msg);
      }
    }
  }
}

// KEY HOOK: install via the patched lean-jspi-st.js source. The patch
// inserts a check for globalThis.__leanFdReadOverride right before
// Asyncify.instrumentWasmImports runs. Our override returns a new
// fd_read function; Asyncify then wraps it with Suspending so the
// async return propagates correctly.
globalThis.__leanFdReadOverride = function (origFdRead) {
  console.log('[fdread] override applied to wasmImports.fd_read');
  return async function fd_read_async(fd, iov, iovcnt, pnum) {
    if (fd !== 0) return origFdRead(fd, iov, iovcnt, pnum);
    let totalRead = 0;
    for (let i = 0; i < iovcnt; i++) {
      const HEAPU32 = new Uint32Array(global.Module.HEAPU8.buffer);
      const ptr = HEAPU32[iov >> 2];
      const len = HEAPU32[(iov + 4) >> 2];
      iov += 8;
      if (len === 0) continue;
      const bytes = await readBytesAsync(len);
      const HEAPU8 = global.Module.HEAPU8;
      for (let j = 0; j < bytes.length; j++) HEAPU8[ptr + j] = bytes[j];
      totalRead += bytes.length;
      if (bytes.length < len) break;
    }
    const HEAPU32 = new Uint32Array(global.Module.HEAPU8.buffer);
    HEAPU32[pnum >> 2] = totalRead;
    console.log('[fdread] fd_read returning ' + totalRead + ' bytes');
    return 0;
  };
};

global.Module = {
  noInitialRun: true,
  stdin: () => null,
  stdout: (b) => { if (b !== null && b !== undefined) { stdoutBytes.push(b); tryParseFrames(); } },
  stderr: (b) => { if (b !== null && b !== undefined) process.stderr.write(Buffer.from([b])); },
  onExit: (status) => { console.log('[fdread] onExit status=' + status); },
  onAbort: (what) => { console.error('[fdread] onAbort:', what); process.exit(3); },
  // Set TZ so Lean doesn't try to read /etc/localtime (which our
  // NODEFS mount doesn't have). UTC keeps us deterministic anyway.
  preRun: [function () {
    if (!global.Module.ENV) global.Module.ENV = {};
    global.Module.ENV.TZ = 'UTC';
    // Provide /etc/localtime in MEMFS — Lean parses this as TZif
    // format. Use the host's actual file so the format is valid.
    const FS = global.Module.FS;
    try { FS.mkdir('/etc'); } catch (_) {}
    try {
      const tz = require('fs').readFileSync('/etc/localtime');
      FS.writeFile('/etc/localtime', new Uint8Array(tz));
    } catch (e) { console.error('[fdread] localtime stub failed:', e.message); }
  }],
};

const leanJsFull = path.join(LEAN_ROOT, LEAN_JS);
if (!fs.readFileSync(leanJsFull, 'utf8').startsWith('// LEAN_NODEFS_PATCHED')) {
  console.log('[fdread] patching', leanJsFull);
  require('node:child_process').execFileSync(
    process.execPath, ['scripts/patch-leanjs.js', leanJsFull],
    { cwd: '/Users/nicholasbulka/prog/lean/wasm', stdio: 'inherit' });
}

require(leanJsFull);

(async () => {
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[fdread] init timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  console.log('[fdread] runtime ready after', waited, 'ms');

  console.log('[fdread] callMain(["--server"])…');
  const callMainResult = global.Module.callMain(['--server']);
  console.log('[fdread] callMain returned, type:', typeof callMainResult,
    callMainResult && typeof callMainResult.then === 'function' ? '(Promise)' : '');

  await new Promise((r) => setTimeout(r, 500));

  console.log('[fdread] sending initialize…');
  const t0 = Date.now();
  let initResp;
  try {
    initResp = await Promise.race([
      request('initialize', { processId: process.pid, rootUri: null, capabilities: {} }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('initialize timeout')), 60_000)),
    ]);
  } catch (e) { console.error('[fdread]', e.message); process.exit(1); }
  console.log('[fdread] ✓ initialize in', Date.now() - t0, 'ms');

  notify('initialized', {});
  const URI = 'inmemory:///main.lean';
  notify('textDocument/didOpen', {
    textDocument: { uri: URI, languageId: 'lean4', version: 1, text: 'def x : Nat := 42\n#eval x\n' },
  });

  await new Promise((r) => setTimeout(r, 1000));

  console.log('[fdread] sending hover…');
  const tH = Date.now();
  let hover;
  try {
    hover = await Promise.race([
      request('textDocument/hover', { textDocument: { uri: URI }, position: { line: 1, character: 6 } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('hover timeout')), 60_000)),
    ]);
  } catch (e) { console.error('[fdread]', e.message); process.exit(1); }
  console.log('[fdread] hover in', Date.now() - tH, 'ms');
  console.log('[fdread] hover.result =', JSON.stringify(hover.result).slice(0, 600));

  if (hover.result?.contents) {
    console.log('[fdread] ✓✓✓ HOVER RESPONSE RECEIVED. Phase 11 architecture complete.');
    process.exit(0);
  } else {
    console.log('[fdread] hover empty — investigate.');
    process.exit(1);
  }
})();
