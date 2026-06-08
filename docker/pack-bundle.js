#!/usr/bin/env node
// Pack a directory tree of compiled .olean / .ilean / .ir files into the
// single binary bundle that the IDE consumes (same wire format as
// /vendor/oleans.bundle).
//
//   [u32 count]
//     [u16 pathLen][pathBytes][u32 dataLen][dataBytes]
//
// Usage:
//   node pack-bundle.js <build-out-dir> <bundle-out-path>
//
// All paths under <build-out-dir> are walked. Files matching the .olean,
// .olean.private, .olean.server, .ilean, .ir extensions are included with
// paths normalized to forward-slash (the WASM FS doesn't care about the
// host's path.sep).

const fs = require('node:fs');
const path = require('node:path');

// --shard-bytes N (or env SHARD_BYTES): if set, emit entry-aligned shards
// <outFile>.000, .001, ... each a STANDALONE bundle (own u32 count header),
// plus <outFile>.manifest.json. Each shard is independently parseable, so
// the worker stages them via its existing multi-bundle path with no
// concatenation. Default 0 = single-file bundle (back-compat for small
// per-dep bundles). 500 MB (decimal) is the recommended cap: it stays
// under Cloudflare's 512 MB free-tier cache limit under either the MB or
// MiB reading, so each shard remains edge-cacheable.
function parseArgs(argv) {
  const positional = [];
  let shardBytes = Number(process.env.SHARD_BYTES || 0);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--shard-bytes') shardBytes = Number(argv[++i]);
    else if (argv[i].startsWith('--shard-bytes=')) shardBytes = Number(argv[i].split('=')[1]);
    else positional.push(argv[i]);
  }
  return { root: positional[0], outFile: positional[1], shardBytes };
}
const { root, outFile, shardBytes } = parseArgs(process.argv.slice(2));
if (!root || !outFile) {
  console.error('usage: pack-bundle.js <build-out-dir> <bundle-out-path> [--shard-bytes N]');
  process.exit(2);
}
if (shardBytes && !Number.isFinite(shardBytes) || shardBytes < 0) {
  console.error('--shard-bytes must be a non-negative number'); process.exit(2);
}

const KEEP = /\.(olean(\.private|\.server)?|ilean|ir)$/;
const entries = [];
function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) walk(full, r);
    else if (KEEP.test(e.name)) entries.push({ rel: r.split(path.sep).join('/'), full });
  }
}
walk(root, '');
entries.sort((a, b) => a.rel.localeCompare(b.rel));

// Encode one entry's framing (everything except the file data itself).
function frame(rel, dataLen) {
  const pb = Buffer.from(rel, 'utf8');
  const pl = Buffer.alloc(2); pl.writeUInt16LE(pb.length, 0);
  const dl = Buffer.alloc(4); dl.writeUInt32LE(dataLen, 0);
  return [pl, pb, dl]; // caller appends data
}

if (!shardBytes) {
  // --- Single-file bundle ------------------------------------------------
  // Stream entry-by-entry: Buffer.concat + one writeFileSync caps out at
  // 2 GiB (ERR_OUT_OF_RANGE), and full Mathlib is ~4.2 GB. Each per-file
  // writeSync stays well under the limit; the wire format is unchanged.
  const fd = fs.openSync(outFile, 'w');
  const cb = Buffer.alloc(4); cb.writeUInt32LE(entries.length, 0);
  fs.writeSync(fd, cb);
  let totalRaw = 0, totalBundle = cb.length;
  for (const e of entries) {
    const data = fs.readFileSync(e.full);
    totalRaw += data.length;
    for (const part of [...frame(e.rel, data.length), data]) { fs.writeSync(fd, part); totalBundle += part.length; }
  }
  fs.closeSync(fd);
  console.log(`[pack-bundle] ${entries.length} files, ${totalRaw} raw bytes -> ${totalBundle} bundle bytes -> ${outFile}`);
} else {
  // --- Sharded: each shard is a standalone bundle ------------------------
  // Greedily pack whole entries into shards capped at shardBytes. A shard's
  // header is rewritten with its final count once the shard is closed.
  const crypto = require('node:crypto');
  const shards = []; // { name, bytes, sha256, count }
  let shardIdx = 0, fd = null, shardCount = 0, shardBundleBytes = 0, shardName = null;
  let totalRaw = 0, totalBundleBytes = 0;

  function openShard() {
    shardName = `${path.basename(outFile)}.${String(shardIdx).padStart(3, '0')}`;
    fd = fs.openSync(path.join(path.dirname(outFile), shardName), 'w');
    const cb = Buffer.alloc(4); cb.writeUInt32LE(0, 0); // placeholder count, rewritten on close
    fs.writeSync(fd, cb);
    shardCount = 0; shardBundleBytes = 4;
  }
  function writeShard(part) { fs.writeSync(fd, part); shardBundleBytes += part.length; }
  function closeShard() {
    if (fd === null) return;
    const cb = Buffer.alloc(4); cb.writeUInt32LE(shardCount, 0);
    fs.writeSync(fd, cb, 0, 4, 0); // overwrite header with real count
    fs.closeSync(fd);
    // Hash the finished shard for the manifest (<=cap bytes, cheap).
    const full = path.join(path.dirname(outFile), shardName);
    const h = crypto.createHash('sha256'); h.update(fs.readFileSync(full));
    shards.push({ name: shardName, bytes: shardBundleBytes, sha256: h.digest('hex'), count: shardCount });
    totalBundleBytes += shardBundleBytes;
    fd = null; shardIdx++;
  }

  openShard();
  for (const e of entries) {
    const data = fs.readFileSync(e.full);
    const parts = [...frame(e.rel, data.length), data];
    const entrySize = parts.reduce((n, p) => n + p.length, 0);
    // Roll to a new shard if this entry would overflow (but never produce an
    // empty shard — a single entry larger than the cap still gets its own).
    if (shardCount > 0 && shardBundleBytes + entrySize > shardBytes) { closeShard(); openShard(); }
    for (const p of parts) writeShard(p);
    shardCount++; totalRaw += data.length;
  }
  closeShard();

  const manifest = {
    format: 'sharded-oleans-bundle/1',
    shardCap: shardBytes,
    totalFiles: entries.length,
    totalRawBytes: totalRaw,
    totalBundleBytes,
    shards, // ordered; concatenation is NOT required — each shard is standalone
  };
  const manifestPath = `${outFile}.manifest.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[pack-bundle] ${entries.length} files, ${totalRaw} raw bytes -> ${shards.length} shards (cap ${shardBytes}), ${totalBundleBytes} total bundle bytes`);
  console.log(`[pack-bundle] manifest -> ${manifestPath}`);
}
