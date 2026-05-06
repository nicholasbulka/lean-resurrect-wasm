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

const [, , root, outFile] = process.argv;
if (!root || !outFile) {
  console.error('usage: pack-bundle.js <build-out-dir> <bundle-out-path>');
  process.exit(2);
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

const parts = [];
const cb = Buffer.alloc(4); cb.writeUInt32LE(entries.length, 0);
parts.push(cb);
let totalRaw = 0;
for (const e of entries) {
  const data = fs.readFileSync(e.full);
  totalRaw += data.length;
  const pb = Buffer.from(e.rel, 'utf8');
  const pl = Buffer.alloc(2); pl.writeUInt16LE(pb.length, 0);
  const dl = Buffer.alloc(4); dl.writeUInt32LE(data.length, 0);
  parts.push(pl, pb, dl, data);
}
const all = Buffer.concat(parts);
fs.writeFileSync(outFile, all);
console.log(`[pack-bundle] ${entries.length} files, ${totalRaw} raw bytes -> ${all.length} bundle bytes -> ${outFile}`);
