// Olean-on-demand smoke.
//
// Models the "proofs expose olean downloads" UX: when Lean tries to open a
// user-library olean that isn't staged locally, a resolver (in a browser
// build: fetch from CDN) supplies the bytes, the harness stages them in the
// VFS, and Lean retries the open.
//
// We test this on a USER library rather than stdlib because the v4.15.0
// release resolves stdlib via a compiled-in install-prefix fallback that
// bypasses LEAN_PATH — which is actually the right product behavior
// (stdlib should always be bundled; only user libraries should be demand-fetched).
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

/**
 * Write a resolver module that copies oleans from REMOTE to the requested
 * path (which is always inside CACHE). Appends each resolved relative path
 * to a log file so tests can observe resolver behavior across process
 * boundaries.
 */
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
        } catch (e) {
          return null;
        }
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

/**
 * Build a tiny user "library" in `remote/` by compiling two lean files. The
 * resulting oleans are what the resolver will serve on demand.
 */
async function seedRemoteLibrary(remote: string): Promise<void> {
  fs.mkdirSync(remote, { recursive: true });

  // MyLib.lean: no imports, one helper.
  const myLib = path.join(remote, 'MyLib.lean');
  fs.writeFileSync(myLib, 'def greet (name : String) : String := "hello " ++ name\n');
  const r1 = await runLean(['-o', path.join(remote, 'MyLib.olean'), `--root=${remote}`, myLib]);
  if (r1.exitCode !== 0) throw new Error('seed MyLib compile failed: ' + r1.stderr);

  // MyLib/Extras.lean: imports MyLib, adds another helper. Two modules
  // ensures the resolver gets called more than once in the first run.
  fs.mkdirSync(path.join(remote, 'MyLib'), { recursive: true });
  const extras = path.join(remote, 'MyLib', 'Extras.lean');
  fs.writeFileSync(extras, 'import MyLib\n\ndef loudGreet (name : String) : String := (greet name).toUpper\n');
  const r2 = await runLean(
    ['-o', path.join(remote, 'MyLib', 'Extras.olean'), `--root=${remote}`, extras],
    { env: { LEAN_EXTRA_PATH: remote } },
  );
  if (r2.exitCode !== 0) throw new Error('seed MyLib.Extras compile failed: ' + r2.stderr);
}

test.describe('olean-on-demand: fetch-on-miss + cache', () => {
  test('first run populates cache via resolver; second run is cache-hot; no resolver → failure', async () => {
    test.setTimeout(12 * 60_000);
    const scratch = makeScratch('resolver');
    const cache = path.join(scratch, 'cache');
    const remote = path.join(scratch, 'remote');
    fs.mkdirSync(cache, { recursive: true });

    // Seed: compile a two-module user library in the remote dir.
    await seedRemoteLibrary(remote);
    expect(fs.existsSync(path.join(remote, 'MyLib.olean'))).toBe(true);
    expect(fs.existsSync(path.join(remote, 'MyLib', 'Extras.olean'))).toBe(true);

    const { resolverPath, callLogPath } = writeResolver(scratch, cache, remote);

    // App imports the library's second module (which transitively needs MyLib).
    const app = path.join(scratch, 'App.lean');
    fs.writeFileSync(app, 'import MyLib.Extras\n#eval loudGreet "world"\n');

    // ------- Run 1: cache cold, with resolver -----------------------------
    const env1 = { LEAN_EXTRA_PATH: cache, LEAN_RESOLVER_JS: resolverPath };
    const r1 = await runLean([app], { env: env1 });
    console.log(`  run1 took ${r1.durationMs}ms; stdout=${r1.stdout.trim()}`);
    if (r1.exitCode !== 0) console.log('  run1 stderr tail:', r1.stderr.slice(-1500));
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(r1.stdout).toContain('HELLO WORLD');

    const run1Calls = readLog(callLogPath);
    console.log(`  run1 resolver calls: ${JSON.stringify(run1Calls)}`);
    // Expect at least MyLib.olean and MyLib/Extras.olean fetched.
    expect(run1Calls.some((c) => c.endsWith('MyLib.olean'))).toBe(true);
    expect(run1Calls.some((c) => c.endsWith('Extras.olean'))).toBe(true);

    // Cache dir now has staged files on real disk (via NODEFS).
    const cachedMyLib = path.join(cache, 'MyLib.olean');
    const cachedExtras = path.join(cache, 'MyLib', 'Extras.olean');
    expect(fs.existsSync(cachedMyLib)).toBe(true);
    expect(fs.existsSync(cachedExtras)).toBe(true);
    // Byte-for-byte identical to remote originals.
    expect(fs.readFileSync(cachedMyLib).equals(fs.readFileSync(path.join(remote, 'MyLib.olean')))).toBe(true);
    expect(fs.readFileSync(cachedExtras).equals(fs.readFileSync(path.join(remote, 'MyLib', 'Extras.olean')))).toBe(true);

    // ------- Run 2: cache warm, resolver still installed but shouldn't fire --
    fs.writeFileSync(callLogPath, '');
    const r2 = await runLean([app], { env: env1 });
    console.log(`  run2 took ${r2.durationMs}ms; stdout=${r2.stdout.trim()}`);
    expect(r2.exitCode, r2.stderr).toBe(0);
    expect(r2.stdout).toContain('HELLO WORLD');
    const run2Calls = readLog(callLogPath);
    console.log(`  run2 resolver calls: ${run2Calls.length}`);
    expect(run2Calls).toHaveLength(0);

    // ------- Run 3: wipe cache, no resolver → clean failure ------------
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true });
    const r3 = await runLean([app], { env: { LEAN_EXTRA_PATH: cache } });
    expect(r3.exitCode).not.toBe(0);
    expect((r3.stdout + r3.stderr).toLowerCase()).toMatch(/unknown (module|package|prefix)/);
  });
});
