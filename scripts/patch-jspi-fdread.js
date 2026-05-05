#!/usr/bin/env node
// Patch a JSPI-built lean.js so that just before
// Asyncify.instrumentWasmImports runs, we look for a
// globalThis.__leanFdReadOverride function and use it to replace
// wasmImports.fd_read. Asyncify then wraps OUR function with
// WebAssembly.Suspending, which is what makes async fd_read
// suspend the WASM stack on Promise return.
//
// Idempotent: looks for the JSPI_FD_READ_HOOK sentinel and skips
// if already patched.
//
// Usage:
//   node scripts/patch-jspi-fdread.js path/to/lean-jspi-*.js

const fs = require('fs');

const target = process.argv[2];
if (!target) { console.error('usage: node patch-jspi-fdread.js <path>'); process.exit(1); }

const src = fs.readFileSync(target, 'utf8');
if (src.includes('JSPI_FD_READ_HOOK')) {
  console.log('[patch-jspi] already patched: ' + target);
  process.exit(0);
}

const needle = 'wasmImports.__instrumented=true;Asyncify.instrumentWasmImports(wasmImports)';
if (!src.includes(needle)) {
  console.error('[patch-jspi] needle not found in ' + target);
  process.exit(2);
}
const inject =
  'wasmImports.__instrumented=true;' +
  'if(typeof globalThis.__leanFdReadOverride==="function"){' +
    'wasmImports.fd_read=globalThis.__leanFdReadOverride(wasmImports.fd_read);' +
  '}/*JSPI_FD_READ_HOOK*/' +
  'Asyncify.instrumentWasmImports(wasmImports)';

fs.writeFileSync(target, src.replace(needle, inject));
console.log('[patch-jspi] hook injected into ' + target);
