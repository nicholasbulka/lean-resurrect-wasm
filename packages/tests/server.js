// Static server for the browser test harness.
//
// Sets COOP/COEP headers so SharedArrayBuffer is available (required because
// the Lean v4.15.0 WASM build is compiled with -pthread). Serves:
//   /            -> public/index.html
//   /*           -> public/*
//   /vendor/*    -> ../../vendor/lean-linux_wasm32/*  (wasm, js, oleans)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const VENDOR = path.resolve(__dirname, '../../vendor/lean-linux_wasm32');
const WORKSPACE = path.resolve(__dirname, '../..');
const HARNESS = path.join(WORKSPACE, 'preflight/trace_fs.js');
// React IDE built output. If not present, `/` falls back to the raw harness.
const IDE_DIST = path.resolve(__dirname, '../ide/dist');
const IDE_AVAILABLE = fs.existsSync(path.join(IDE_DIST, 'index.html'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.olean': 'application/octet-stream',
  '.a': 'application/octet-stream',
  '.so': 'application/octet-stream',
};

function headers(size, mime) {
  return {
    'Content-Type': mime,
    'Content-Length': size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('directory listing not allowed');
      return;
    }
    res.writeHead(200, headers(stat.size, mime));
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + filePath);
  }
}

// Walk a dir and collect relative paths matching a filter.
function walk(dir, root, filter, acc) {
  acc = acc || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      walk(full, root, filter, acc);
    } else if (filter(full)) {
      acc.push({ path: path.relative(root, full), size: st.size });
    }
  }
  return acc;
}

// Cache the manifest — regenerating on every request on 512 MB of oleans is slow.
let manifestCache = null;
function getManifest() {
  if (manifestCache) return manifestCache;
  const leanLib = path.join(VENDOR, 'lib', 'lean');
  // v4.27 module system splits per-module data into four file types:
  //   .olean          — exported (always required)
  //   .olean.server   — server-level (LSP)
  //   .olean.private  — private (full elaborator)
  //   .ir             — IR for tactic interpretation
  // Lean's findOLeanParts loads parts[0..2] by ctorIdx; missing files
  // surface as "missing data file" / "missing IR data file". We must
  // ship all four for elaboration to succeed in-browser.
  const entries = walk(leanLib, leanLib, (p) =>
    p.endsWith('.olean') ||
    p.endsWith('.olean.server') ||
    p.endsWith('.olean.private') ||
    p.endsWith('.ir')
  );
  manifestCache = {
    root: '/vendor/lib/lean',
    count: entries.length,
    totalSize: entries.reduce((a, e) => a + e.size, 0),
    entries, // [{ path: 'Init.olean', size: N }, { path: 'Init/Prelude.olean', size: ... }, ...]
  };
  return manifestCache;
}

// POST /api/compile
//   body:  { source, libraryPaths?: string[] }
//   reply: { stdout, stderr, exitCode, ms, diagnostics: LeanDiagnostic[] }
//
// Spawns trace_fs.js on a scratch copy of source with --json so Lean emits
// one JSON record per diagnostic. Plain stdout / stderr are also returned
// (--json separates them: #eval results still go to stdout as JSON too).
async function handleCompile(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('POST only');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid JSON body');
    return;
  }
  const source = String(parsed.source ?? '');
  if (source.length > 1024 * 1024) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end('source too large');
    return;
  }
  const libraryPaths = Array.isArray(parsed.libraryPaths) ? parsed.libraryPaths.filter((p) => typeof p === 'string' && p.trim()) : [];

  const scratchDir = path.join(WORKSPACE, '.compile-scratch', 'c-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(scratchDir, { recursive: true });
  const leanFile = path.join(scratchDir, 'Input.lean');
  fs.writeFileSync(leanFile, source);

  const env = { ...process.env };
  if (libraryPaths.length) env.LEAN_EXTRA_PATH = libraryPaths.join(':');

  const started = Date.now();
  const proc = spawn(
    'node',
    ['--stack-size=8192', HARNESS, '--json', `--root=${scratchDir}`, leanFile],
    { cwd: WORKSPACE, env }
  );
  let stdout = '';
  let stderr = '';
  let clientAborted = false;
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    const keep = s
      .split('\n')
      .filter((l) => !/^\[harness]|^\[fs]|locateFile lean\.wasm|locateFile lean\.worker\.js/.test(l))
      .join('\n');
    stderr += keep;
  });
  const TIMEOUT_MS = 4 * 60_000;
  const killTimer = setTimeout(() => { proc.kill('SIGKILL'); }, TIMEOUT_MS);
  // If the client hangs up (Fetch AbortController / navigation away), kill
  // the subprocess so it isn't orphaned chewing CPU for nothing.
  const onReqClose = () => {
    if (!res.writableEnded) {
      clientAborted = true;
      proc.kill('SIGKILL');
    }
  };
  req.on('close', onReqClose);
  const exitCode = await new Promise((resolve) => {
    proc.on('close', (code) => { clearTimeout(killTimer); resolve(code ?? -1); });
    proc.on('error', () => { clearTimeout(killTimer); resolve(-1); });
  });
  req.off('close', onReqClose);
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {}
  if (clientAborted) {
    // Response was already abandoned by the client; don't try to write.
    return;
  }

  // Parse --json output. Lean emits one JSON record per message on stdout.
  // Non-JSON lines (e.g. from #eval that wasn't adapted to JSON) pass through.
  const diagnostics = [];
  const residualStdout = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.severity && obj.pos && typeof obj.pos.line === 'number') {
          diagnostics.push(obj);
          continue;
        }
      } catch (_) { /* fall through */ }
    }
    residualStdout.push(line);
  }

  const body = JSON.stringify({
    stdout: residualStdout.join('\n'),
    stderr,
    exitCode,
    ms: Date.now() - started,
    diagnostics,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.end(body);
}

// POST /api/project/scan
//   body:  { root: string }
//   reply: { name, root, files: [{ path: relativePath, content: string }] }
//
// Safety: this is a local-dev server, but we still require absolute paths
// and reject obvious traversal attempts. There's no allowlist beyond
// "must be an absolute path that exists and is a directory" — for a
// shared/remote deployment, gate this behind explicit roots.
async function handleProjectScan(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('POST only');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('invalid JSON body');
    return;
  }
  const root = String(parsed.root ?? '');
  if (!root || !path.isAbsolute(root)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('root must be an absolute path');
    return;
  }
  let st;
  try { st = fs.statSync(root); } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no such directory');
    return;
  }
  if (!st.isDirectory()) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('root is not a directory');
    return;
  }

  const files = [];
  // Walk only .lean files. Skip lake artifact dirs and hidden dirs.
  const SKIP = new Set(['.lake', '.git', 'node_modules', 'build']);
  function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scan(full); }
      else if (e.isFile() && full.endsWith('.lean')) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          if (content.length > 2 * 1024 * 1024) continue; // 2 MB cap per file
          files.push({ path: path.relative(root, full), content });
        } catch (_) { /* skip unreadable */ }
      }
    }
  }
  scan(root);
  // Cap total size — if a project is larger than 16 MB of .lean source we
  // probably shouldn't be loading it all into the browser anyway.
  const totalBytes = files.reduce((a, f) => a + f.content.length, 0);
  if (totalBytes > 16 * 1024 * 1024) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end(`project too large (${totalBytes} bytes across ${files.length} files)`);
    return;
  }
  // Stable order by path for predictable test output.
  files.sort((a, b) => a.path.localeCompare(b.path));
  const body = JSON.stringify({ name: path.basename(root), root, files });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.end(body);
}

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/compile') return handleCompile(req, res);
  if (url.pathname === '/api/project/scan') return handleProjectScan(req, res);
  let target;
  if (url.pathname === '/vendor/manifest.json') {
    const body = JSON.stringify(getManifest());
    res.writeHead(200, headers(Buffer.byteLength(body), 'application/json; charset=utf-8'));
    res.end(body);
    return;
  }
  // React IDE (built): / and /assets/* served from packages/ide/dist.
  if (IDE_AVAILABLE && (url.pathname === '/' || url.pathname === '/index.html')) {
    target = path.join(IDE_DIST, 'index.html');
  } else if (IDE_AVAILABLE && url.pathname.startsWith('/assets/')) {
    const rel = url.pathname.slice('/assets/'.length);
    target = path.join(IDE_DIST, 'assets', rel);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(IDE_DIST))) { res.writeHead(403); res.end(); return; }
  }
  // Raw WASM harness lives at /debug now (was /).
  else if (url.pathname === '/debug' || url.pathname === '/debug/') {
    target = path.join(ROOT, 'index.html');
  } else if (url.pathname === '/') {
    // No built IDE yet — fall through to raw harness with a note.
    target = path.join(ROOT, 'index.html');
  } else if (url.pathname.startsWith('/vendor/')) {
    const rel = url.pathname.slice('/vendor/'.length);
    target = path.join(VENDOR, rel);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(VENDOR))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
  } else {
    const rel = url.pathname.replace(/^\/+/, '');
    // Top-level files copied from packages/ide/public (Vite copies them to
    // dist/) — e.g. leanWorker.js — should be served before falling back to
    // the legacy raw harness root.
    if (IDE_AVAILABLE && fs.existsSync(path.join(IDE_DIST, rel))) {
      const candidate = path.join(IDE_DIST, rel);
      const resolvedDist = path.resolve(candidate);
      if (resolvedDist.startsWith(path.resolve(IDE_DIST))) {
        target = candidate;
        sendFile(res, target);
        return;
      }
    }
    target = path.join(ROOT, rel);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(ROOT))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
  }
  sendFile(res, target);
});

const PORT = Number(process.env.PORT) || 8787;
srv.listen(PORT, () => {
  console.log(`[tests-server] listening on http://localhost:${PORT}`);
  console.log(`[tests-server]   ROOT   = ${ROOT}`);
  console.log(`[tests-server]   VENDOR = ${VENDOR}`);
});
