// Minimum LSP smoke: spawn lean --server in Node, send initialize, wait for a response.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(__dirname, 'trace_fs.js');

const p = spawn('node', ['--stack-size=8192', HARNESS, '--server'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
p.stdout.on('data', (d) => {
  buf += d.toString();
  // Try to parse LSP frames.
  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const hdr = buf.slice(0, headerEnd);
    const m = /Content-Length:\s*(\d+)/i.exec(hdr);
    if (!m) { buf = buf.slice(headerEnd + 4); continue; }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) return;
    const body = buf.slice(start, start + len);
    buf = buf.slice(start + len);
    console.log('[lsp-recv]', body.slice(0, 400));
  }
});
p.stderr.on('data', (d) => {
  const s = d.toString();
  // Filter harness spam.
  const keep = s.split('\n').filter((l) => !/^\[harness\]|locateFile/.test(l)).join('\n');
  if (keep.trim()) process.stderr.write('[stderr] ' + keep);
});
p.on('close', (c) => console.log('[exit]', c));

function send(obj) {
  const body = JSON.stringify(obj);
  const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  p.stdin.write(framed);
  console.log('[lsp-send]', body.slice(0, 200));
}

// Give lean time to init (wasm cold boot + watchdog thread start), then send.
setTimeout(() => {
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      processId: process.pid,
      rootUri: 'file:///work',
      capabilities: {},
    },
  });
}, 2000);

// Keep process alive so we can observe output.
setTimeout(() => {
  console.log('[smoke] timeout, killing');
  p.kill();
  process.exit(0);
}, 60000);
