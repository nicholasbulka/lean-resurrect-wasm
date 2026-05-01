// Olean-on-demand smoke.
//
// Models the "proofs expose olean downloads" UX: when Lean tries to open a
// user-library olean that isn't staged locally, a resolver (in a browser
// build: fetch from CDN) supplies the bytes, the harness stages them in
// the VFS, and Lean retries the open.
//
// We test on a USER library rather than stdlib because stdlib resolves via
// install-prefix fallback that bypasses LEAN_PATH.
//
// Validates:
//   1. First run with empty cache: resolver is called once per user module;
//      cache is populated byte-for-byte from the "remote" store.
//   2. Second run with warm cache: resolver is not called at all.
//   3. Without a resolver, the import fails with a clear error.

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runLean, WORKSPACE } from './_lib/spawn.js';

function makeScratch(name: string): string {
  const dir = path.join(WORKSPACE, '.test-scratch', `${name}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jsonLines(stdout: string): any[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{') && s.endsWith('}'))
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}

function writeResolver(scratch: string, cacheRoot: string, remoteRoot: string): {
  resolverPath: string;
  callLogPath: string;
} {
  const callLogPath = path.join(scratch, 'resolver-calls.log');
  const resolverPath = path.join(scratch, 'resolver.cjs');
  const source = `
    const fs = require('fs');
    const path = require('path');
    const CACHE_ROOT = ${JSON.stringify(cacheRoot)};
    const REMOTE_ROOT = ${JSON.stringify(remoteRoot)};
    const LOG = ${JSON.stringify(callLogPath)};
    module.exports = {
      resolve(p) {
        if (!p.startsWith(CACHE_ROOT + path.sep) && !p.startsWith(CACHE_ROOT + '/')) return null;
        const rel = p.slice(CACHE_ROOT.length).replace(/^[\\\\/]+/, '');
        const remotePath = path.join(REMOTE_ROOT, rel);
        try {
          const bytes = fs.readFileSync(remotePath);
          fs.appendFileSync(LOG, rel + '\\n');
          return bytes;
        } catch (e) { return null; }
      },
    };
  `;
  fs.writeFileSync(resolverPath, source);
  fs.writeFileSync(callLogPath, '');
  return { resolverPath, callLogPath };
}

function readLog(p: string): string[] {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

async function seedRemoteLibrary(remote: string): Promise<void> {
  fs.mkdirSync(remote, { recursive: true });

  // `module` header so the compiler emits .olean.server / .olean.private
  // / .ir alongside .olean. Without those, downstream imports fail with
  // "missing data file" because findOLeanParts indexes parts[level.ctorIdx].
  const myLib = path.join(remote, 'MyLib.lean');
  fs.writeFileSync(myLib, 'module\npublic def greet (name : String) : String := "hello " ++ name\n');
  const r1 = await runLean(['-o', path.join(remote, 'MyLib.olean'), `--root=${remote}`, myLib], 6 * 60_000);
  if (!fs.existsSync(path.join(remote, 'MyLib.olean'))) {
    throw new Error('seed MyLib compile produced no olean: ' + r1.stderr);
  }

  fs.mkdirSync(path.join(remote, 'MyLib'), { recursive: true });
  const extras = path.join(remote, 'MyLib', 'Extras.lean');
  fs.writeFileSync(
    extras,
    'module\nimport MyLib\npublic def loudGreet (name : String) : String := (greet name).toUpper\n',
  );
  const r2 = await runLean(
    ['-o', path.join(remote, 'MyLib', 'Extras.olean'), `--root=${remote}`, extras],
    { env: { LEAN_EXTRA_PATH: remote }, timeoutMs: 6 * 60_000 },
  );
  if (!fs.existsSync(path.join(remote, 'MyLib', 'Extras.olean'))) {
    throw new Error('seed MyLib.Extras compile produced no olean: ' + r2.stderr);
  }
}

// SKIPPED — same blocker as node-byoml.spec.ts. See that file for the
// full chain-of-events explanation.
//
// Specific to this test: the FS.stat / FS.open interceptor in
// preflight/trace_fs.js fires resolver.resolve(p) for any *.olean,
// *.olean.server, *.olean.private, or *.ir path that returns ENOENT.
// That interceptor IS being installed correctly (verified via the
// preRun setup), but it never gets called for user libraries because
// Lean's search path doesn't include the user's cache directory:
// LEAN_PATH wasn't honored, so the *only* paths Lean looks at are
// under the install-prefix's lib/lean (where stdlib lives). User
// libraries don't have entries in install-prefix/lib/lean, so Lean
// errors with "unknown module prefix" before any FS.open even fires.
//
// Re-enable conditions (same as node-byoml.spec.ts):
//   (a) LEAN_PATH propagation to the pthread worker, OR
//   (b) Lean rebuilt with init_search_path reading LEAN_PATH another
//       way, OR
//   (c) Drop PROXY_TO_PTHREAD (loses Web Worker compatibility).
//
// Once LEAN_PATH is honored, this test should work as-is: it pre-
// compiles a 2-module library to a `remote/` directory, mounts a
// `cache/` directory via LEAN_EXTRA_PATH, and verifies the resolver
// fires for missing oleans, the cache populates byte-for-byte, and
// warm-cache runs don't re-fire the resolver.
test.describe.skip('olean-on-demand: fetch-on-miss + cache', () => {
  test('first run populates cache; second run is cache-hot; no resolver → failure', async () => {
    test.setTimeout(20 * 60_000);
    const scratch = makeScratch('resolver');
    const cache = path.join(scratch, 'cache');
    const remote = path.join(scratch, 'remote');
    fs.mkdirSync(cache, { recursive: true });

    await seedRemoteLibrary(remote);
    expect(fs.existsSync(path.join(remote, 'MyLib.olean'))).toBe(true);
    expect(fs.existsSync(path.join(remote, 'MyLib', 'Extras.olean'))).toBe(true);

    const { resolverPath, callLogPath } = writeResolver(scratch, cache, remote);

    const app = path.join(scratch, 'App.lean');
    fs.writeFileSync(app, 'import MyLib.Extras\n#eval loudGreet "world"\n');

    // ------- Run 1: cache cold, with resolver -----------------------------
    const env1 = { LEAN_EXTRA_PATH: cache, LEAN_RESOLVER_JS: resolverPath };
    const r1 = await runLean(['--json', app], { env: env1, timeoutMs: 6 * 60_000 });
    console.log(`  run1 took ${r1.durationMs}ms`);
    const msgs1 = jsonLines(r1.stdout);
    expect(msgs1.some((m: any) => /HELLO WORLD/.test(String(m.data)))).toBe(true);

    const run1Calls = readLog(callLogPath);
    console.log(`  run1 resolver calls: ${run1Calls.length}`);
    // Each module has up to four files (.olean, .olean.server,
    // .olean.private, .ir). Just assert the resolver was called for at
    // least one part of each module.
    expect(run1Calls.some((c) => c.includes('MyLib.olean'))).toBe(true);
    expect(run1Calls.some((c) => c.includes('Extras.olean'))).toBe(true);

    // At least the canonical .olean files should be staged byte-identical.
    const cachedMyLib = path.join(cache, 'MyLib.olean');
    const cachedExtras = path.join(cache, 'MyLib', 'Extras.olean');
    expect(fs.existsSync(cachedMyLib)).toBe(true);
    expect(fs.existsSync(cachedExtras)).toBe(true);
    expect(fs.readFileSync(cachedMyLib).equals(fs.readFileSync(path.join(remote, 'MyLib.olean')))).toBe(true);
    expect(fs.readFileSync(cachedExtras).equals(fs.readFileSync(path.join(remote, 'MyLib', 'Extras.olean')))).toBe(true);

    // ------- Run 2: cache warm, resolver shouldn't fire -------------------
    fs.writeFileSync(callLogPath, '');
    const r2 = await runLean(['--json', app], { env: env1, timeoutMs: 6 * 60_000 });
    console.log(`  run2 took ${r2.durationMs}ms`);
    const msgs2 = jsonLines(r2.stdout);
    expect(msgs2.some((m: any) => /HELLO WORLD/.test(String(m.data)))).toBe(true);
    const run2Calls = readLog(callLogPath);
    console.log(`  run2 resolver calls: ${run2Calls.length}`);
    expect(run2Calls).toHaveLength(0);

    // ------- Run 3: wipe cache, no resolver → clean error -----------------
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true });
    const r3 = await runLean(['--json', app], { env: { LEAN_EXTRA_PATH: cache }, timeoutMs: 4 * 60_000 });
    const msgs3 = jsonLines(r3.stdout);
    const errors = msgs3.filter((m: any) => m.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((m: any) => /unknown (module|package|prefix)/i.test(String(m.data)))).toBe(true);
  });
});
