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
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const VENDOR = path.resolve(__dirname, '../../vendor/lean-linux_wasm32');
const WORKSPACE = path.resolve(__dirname, '../..');
// CDN stub: simulates a remote host for wasm32-compiled Lean projects.
// See cdn/README.md.
const CDN_ROOT = path.resolve(__dirname, '../../cdn');
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

function headers(size, mime, urlPath) {
  // /vendor/* is immutable per Lean build (lean.js, lean.wasm, oleans).
  // Aggressive caching saves the ~250MB WASM + ~7700-file olean re-fetch
  // on every reload / worker re-spawn. Everything else (IDE bundle, API
  // responses) stays no-store so dev changes are visible immediately.
  const cacheControl = urlPath && urlPath.startsWith('/vendor/')
    ? 'public, max-age=86400, immutable'
    : 'no-store';
  return {
    'Content-Type': mime,
    'Content-Length': size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': cacheControl,
  };
}

function sendFile(res, filePath, urlPath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('directory listing not allowed');
      return;
    }
    res.writeHead(200, headers(stat.size, mime, urlPath));
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

// Build a single packed binary of all oleans for given prefixes.
// Format (all little-endian):
//   u32 count
//   per entry:
//     u16 pathLen   (UTF-8 bytes)
//     pathBytes
//     u32 dataLen
//     dataBytes
// One fetch instead of 7715 round-trips through the browser cache.
let bundleCache = null;     // raw concatenation
let bundleGzCache = null;   // gzipped (precomputed lazily on first gz request)
function getOleanBundle() {
  if (bundleCache) return bundleCache;
  const STAGE_PREFIXES = ['Init', 'Std', 'Lean'];
  const manifest = getManifest();
  const entries = manifest.entries.filter((e) => {
    const seg = e.path.split('/')[0].replace(/\.olean(\.private|\.server)?$|\.ir$/, '');
    return STAGE_PREFIXES.includes(seg);
  });
  const leanLib = path.join(VENDOR, 'lib', 'lean');
  const parts = [];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(entries.length, 0);
  parts.push(countBuf);
  for (const e of entries) {
    const data = fs.readFileSync(path.join(leanLib, e.path));
    const pathBuf = Buffer.from(e.path, 'utf8');
    const pathLen = Buffer.alloc(2);
    pathLen.writeUInt16LE(pathBuf.length, 0);
    const dataLen = Buffer.alloc(4);
    dataLen.writeUInt32LE(data.length, 0);
    parts.push(pathLen, pathBuf, dataLen, data);
  }
  bundleCache = Buffer.concat(parts);
  console.log('[tests-server] olean bundle: ' + entries.length + ' files, ' + (bundleCache.length / 1048576).toFixed(1) + ' MB');
  return bundleCache;
}
function getOleanBundleGz() {
  if (bundleGzCache) return bundleGzCache;
  const raw = getOleanBundle();
  const t0 = Date.now();
  // level 1 = fastest, still ~30% reduction on this binary content.
  // The bundle is gigabyte-class so level 6 (default) takes 30+ seconds
  // on first request; level 1 takes ~3-5s and the difference in size
  // is small for already-binary data.
  bundleGzCache = zlib.gzipSync(raw, { level: 1 });
  console.log('[tests-server] olean bundle gzipped: ' + (bundleGzCache.length / 1048576).toFixed(1) + ' MB in ' + (Date.now() - t0) + 'ms');
  return bundleGzCache;
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
// Olean header layout (src/library/module.cpp:78):
//   [0..5)   magic     "olean"
//   [5]      version   1 byte (currently 2)
//   [6]      flags     1 byte (bit 0: GMP)
//   [7..40)  lean_version  33 bytes, '\0'-padded
//   [40..80) githash       40 bytes, '\0'-padded
//   [80..)   base_addr (size_t — wasm32: 4 bytes, native: 8 bytes), then payload
// Bytes 0..80 are arch-independent text fields; if the project's olean and
// our vendored stdlib's olean disagree here, Lean's loader will reject with
// "incompatible header" — the project was built with a different toolchain
// (e.g. native x86_64 release vs our wasm32 -pre build).
const OLEAN_HEADER_FIXED_LEN = 80;
let __vendorOleanSignature = null;
function getVendorOleanSignature() {
  if (__vendorOleanSignature) return __vendorOleanSignature;
  const probe = path.join(VENDOR, 'lib/lean/Init.olean');
  const fd = fs.openSync(probe, 'r');
  const buf = Buffer.alloc(OLEAN_HEADER_FIXED_LEN);
  fs.readSync(fd, buf, 0, OLEAN_HEADER_FIXED_LEN, 0);
  fs.closeSync(fd);
  __vendorOleanSignature = buf;
  return __vendorOleanSignature;
}
function describeOleanHeader(buf) {
  const magic = buf.slice(0, 5).toString('ascii');
  const version = buf[5];
  const flags = buf[6];
  const leanVersion = buf.slice(7, 40).toString('ascii').replace(/\0+$/, '');
  const githash = buf.slice(40, 80).toString('ascii').replace(/\0+$/, '');
  return { magic, version, flags, leanVersion, githash };
}

// POST /api/project/oleans
//   body: { root: string }
//   reply on compatible build: packed binary bundle (same format as
//          /vendor/oleans.bundle). Empty bundle if no .lake/ exists.
//   reply 422: { error: 'incompatible-olean-toolchain', expected, actual,
//                sampleFile } — when the project's prebuilt oleans were
//          built with a different Lean toolchain than our wasm32 stdlib.
async function handleProjectOleans(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('POST only');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { res.writeHead(400); res.end('bad json'); return; }
  const root = String(parsed.root ?? '');
  if (!root || !path.isAbsolute(root)) { res.writeHead(400); res.end('absolute root required'); return; }
  const lakeLib = path.join(root, '.lake', 'build', 'lib', 'lean');
  let entries = [];
  try {
    if (fs.statSync(lakeLib).isDirectory()) {
      entries = walk(lakeLib, lakeLib, (p) =>
        p.endsWith('.olean') || p.endsWith('.olean.private') ||
        p.endsWith('.olean.server') || p.endsWith('.ir')
      );
    }
  } catch (_) { /* no .lake — return empty bundle */ }

  // Compatibility check: if the project has any .olean files, sample
  // the first one's header and compare against our vendored stdlib's
  // signature. Mismatch means the user's project was built with a
  // different toolchain (different Lean version, GMP flag, or githash;
  // most commonly: native x86_64 vs our wasm32 build). Lean's loader
  // would reject these at runtime; fail fast here with a clear message.
  const sampleOlean = entries.find((e) => e.path.endsWith('.olean'));
  if (sampleOlean) {
    const fd = fs.openSync(path.join(lakeLib, sampleOlean.path), 'r');
    const sampleBuf = Buffer.alloc(OLEAN_HEADER_FIXED_LEN);
    fs.readSync(fd, sampleBuf, 0, OLEAN_HEADER_FIXED_LEN, 0);
    fs.closeSync(fd);
    const expectedSig = getVendorOleanSignature();
    if (!sampleBuf.equals(expectedSig)) {
      const expected = describeOleanHeader(expectedSig);
      const actual = describeOleanHeader(sampleBuf);
      const reasons = [];
      if (expected.flags !== actual.flags) reasons.push(`flags differ (expected ${expected.flags}, got ${actual.flags} — likely GMP build vs no-GMP)`);
      if (expected.leanVersion !== actual.leanVersion) reasons.push(`lean_version "${expected.leanVersion}" vs "${actual.leanVersion}"`);
      if (expected.githash !== actual.githash) reasons.push(`githash "${expected.githash || '(empty)'}" vs "${actual.githash}"`);
      if (expected.version !== actual.version) reasons.push(`olean schema v${expected.version} vs v${actual.version}`);
      const body = JSON.stringify({
        error: 'incompatible-olean-toolchain',
        message: 'Project oleans were built with a different Lean toolchain than the WASM stdlib bundled with this IDE. They cannot be loaded in browser-mode compile.',
        reasons,
        expected,
        actual,
        sampleFile: sampleOlean.path,
        oleanCount: entries.length,
      });
      console.log('[tests-server] incompatible project oleans at ' + lakeLib + ': ' + reasons.join('; '));
      res.writeHead(422, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
  }
  const parts = [];
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(entries.length, 0);
  parts.push(countBuf);
  for (const e of entries) {
    const data = fs.readFileSync(path.join(lakeLib, e.path));
    const pathBuf = Buffer.from(e.path, 'utf8');
    const pathLen = Buffer.alloc(2); pathLen.writeUInt16LE(pathBuf.length, 0);
    const dataLen = Buffer.alloc(4); dataLen.writeUInt32LE(data.length, 0);
    parts.push(pathLen, pathBuf, dataLen, data);
  }
  const body = Buffer.concat(parts);
  console.log('[tests-server] project oleans: ' + entries.length + ' files, ' + (body.length / 1048576).toFixed(1) + ' MB from ' + lakeLib);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// GET /cdn/projects
//   reply: { projects: [{ id, name, sourceCount, oleansBundleBytes }, ...] }
// Lists every directory under cdn/projects/ that has a sources.json. The
// IDE's "from CDN" flow polls this to populate its picker.
function handleCdnProjectList(req, res) {
  let entries = [];
  try {
    const dirs = fs.readdirSync(path.join(CDN_ROOT, 'projects'), { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const slug = d.name;
      const projDir = path.join(CDN_ROOT, 'projects', slug);
      const srcPath = path.join(projDir, 'sources.json');
      if (!fs.existsSync(srcPath)) continue;
      let manifest;
      try { manifest = JSON.parse(fs.readFileSync(srcPath, 'utf8')); } catch (_) { continue; }
      // Oleans ship either as a single oleans.bundle or, for large libs,
      // as ~500 MB shards described by oleans.bundle.manifest.json. Report
      // total bytes either way; flag sharded so the UI can hint at size.
      let oleansBundleBytes = 0, sharded = false;
      try { oleansBundleBytes = fs.statSync(path.join(projDir, 'oleans.bundle')).size; } catch (_) {}
      if (!oleansBundleBytes) {
        try {
          const sm = JSON.parse(fs.readFileSync(path.join(projDir, 'oleans.bundle.manifest.json'), 'utf8'));
          if (Array.isArray(sm.shards)) { oleansBundleBytes = sm.totalBundleBytes || 0; sharded = true; }
        } catch (_) {}
      }
      entries.push({
        id: slug,
        name: manifest.name || slug,
        sourceCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
        oleansBundleBytes,
        sharded,
      });
    }
  } catch (_) { /* CDN dir missing; serve empty list */ }
  const body = JSON.stringify({ projects: entries });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// GET /cdn/projects/<id>/sources.json
// GET /cdn/projects/<id>/oleans.bundle
// Plain static file serving from cdn/projects/<id>/. The CDN host is
// responsible for ensuring oleans.bundle is wasm32-compatible — the
// IDE skips the toolchain compatibility check for CDN imports (unlike
// /api/project/oleans which validates local disk projects).
function handleCdnProjectAsset(req, res, url) {
  const rel = url.pathname.slice('/cdn/projects/'.length);
  const target = path.join(CDN_ROOT, 'projects', rel);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(path.join(CDN_ROOT, 'projects')) + path.sep) &&
      resolved !== path.resolve(path.join(CDN_ROOT, 'projects'))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(resolved)) { res.writeHead(404); res.end('not found'); return; }
  // Mime by extension; default to octet-stream for .bundle.
  let mime = 'application/octet-stream';
  if (rel.endsWith('.json')) mime = 'application/json; charset=utf-8';
  const stat = fs.statSync(resolved);
  // CDN files are conceptually content-addressable, so cache them
  // aggressively the same way /vendor/* is cached.
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'public, max-age=86400, immutable',
  });
  fs.createReadStream(resolved).pipe(res);
}

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
  if (url.pathname === '/api/project/oleans') return handleProjectOleans(req, res);
  if (url.pathname === '/cdn/projects') return handleCdnProjectList(req, res);
  if (url.pathname.startsWith('/cdn/projects/')) return handleCdnProjectAsset(req, res, url);
  let target;
  if (url.pathname === '/vendor/manifest.json') {
    const body = JSON.stringify(getManifest());
    res.writeHead(200, headers(Buffer.byteLength(body), 'application/json; charset=utf-8', url.pathname));
    res.end(body);
    return;
  }
  if (url.pathname === '/vendor/oleans.bundle') {
    const accept = String(req.headers['accept-encoding'] || '');
    if (accept.includes('gzip')) {
      const b = getOleanBundleGz();
      const h = headers(b.length, 'application/octet-stream', url.pathname);
      h['Content-Encoding'] = 'gzip';
      h['Vary'] = 'Accept-Encoding';
      res.writeHead(200, h);
      res.end(b);
    } else {
      const b = getOleanBundle();
      res.writeHead(200, headers(b.length, 'application/octet-stream', url.pathname));
      res.end(b);
    }
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
        sendFile(res, target, url.pathname);
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
  sendFile(res, target, url.pathname);
});

const PORT = Number(process.env.PORT) || 8787;
srv.listen(PORT, () => {
  console.log(`[tests-server] listening on http://localhost:${PORT}`);
  console.log(`[tests-server]   ROOT   = ${ROOT}`);
  console.log(`[tests-server]   VENDOR = ${VENDOR}`);
});
