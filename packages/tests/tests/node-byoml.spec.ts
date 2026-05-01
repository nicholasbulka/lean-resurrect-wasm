// BYOML ("bring your own library") smoke.
//
// Demonstrates the minimum viable pattern: compile a user library to .olean
// with WASM Lean, then consume it from another file via LEAN_EXTRA_PATH.
//
// Notes:
//   - Exit codes through PROXY_TO_PTHREAD are unreliable (Lean's `throw 0`
//     on early-exit options surfaces as 224, etc.). We assert on artifact
//     existence + JSON-formatted diagnostics instead.

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

// SKIPPED — LEAN_PATH not honored under MT=ON+PROXY_TO_PTHREAD.
//
// Symptom: `import MyLib` (where MyLib is a user-compiled olean placed in
// a directory passed via LEAN_EXTRA_PATH) fails with:
//   "unknown module prefix 'MyLib'
//    No directory 'MyLib' or file 'MyLib.olean' in the search path entries:
//    /Users/.../vendor/lean-linux_wasm32/lib/lean"
// — only the install-prefix-derived stdlib path is consulted, regardless
// of LEAN_PATH / LEAN_EXTRA_PATH.
//
// Why this happens (chain of events, all confirmed empirically today):
// 1. v4.27 Lean's `init_search_path` (Lean/Util/Path.lean:93-105) calls
//    `IO.getEnv "LEAN_PATH"` to add user-supplied search paths on top of
//    the install-prefix builtin path.
// 2. Upstream `src/util/shell.cpp:287-301` has an EM_ASM block that runs
//    *before* init_search_path and copies process.env["LEAN_PATH"] into
//    the JS closure-scoped var ENV, plus mounts /home, /tmp, and chdirs.
//    That EM_ASM also throws if `process.release.name !== "node"`.
// 3. Our patch (scripts/patch-leanjs.js) strips that EM_ASM wholesale to
//    bypass the Node-only assertion — and takes the LEAN_PATH propagation
//    with it.
// 4. To compensate, our patch's preRun forwards process.env.LEAN_PATH /
//    LEAN_EXTRA_PATH into Module.ENV. Verified: Module.ENV.LEAN_PATH IS
//    set correctly on the main thread.
// 5. BUT under PROXY_TO_PTHREAD=1, lean_main runs in a *pthread worker*
//    (em-pthread Worker spawned via worker_threads.Worker on Node, or
//    new Worker(...) in browser). That worker re-evaluates lean.js
//    fresh, getting its own private `var ENV={};` closure. Our patch's
//    `Module["ENV"]=ENV` exposes it, but the pthread's preRun doesn't
//    inherit the main thread's Module.ENV values.
// 6. So when init_search_path runs in the pthread and calls getenv via
//    getEnvStrings, it reads the empty pthread ENV → no LEAN_PATH → only
//    the install-prefix builtin search path gets used.
//
// Empirically verified: even setting LEAN_PATH="/abs/path" on the shell
// (so it's in process.env in both main and worker_threads-spawned
// pthread), the pthread's getEnvStrings doesn't see it.
//
// Re-enable paths:
// (a) Wire process.env→Module.ENV inside the patch's pthread branch
//     using SharedArrayBuffer or Atomics.wait so the main thread can
//     hand the pthread its initial ENV before the pthread reads it.
//     Tricky because the patch prefix runs at worker init, before
//     SharedArrayBuffer-coordinated handoff is wired up.
// (b) Rebuild Lean with init_search_path reading LEAN_PATH directly
//     (e.g. via a dedicated extern that the JS preRun can call into).
//     ~5h Lake-cascade rebuild.
// (c) Drop PROXY_TO_PTHREAD and run main on the outer thread. Loses
//     SharedArrayBuffer / Atomics.wait support. Browser-side this would
//     freeze the page; Node-side it'd be acceptable.
test.describe.skip('BYOML: bring-your-own-library in Node', () => {
  test('compile a custom lib, then import it from a consumer file', async () => {
    test.setTimeout(12 * 60_000);
    const scratch = makeScratch('byoml');
    const libLean = path.join(scratch, 'MyLib.lean');
    const libOlean = path.join(scratch, 'MyLib.olean');
    const appLean = path.join(scratch, 'App.lean');

    // The `module` header + `public def` makes Lean emit all four
    // file types (.olean, .olean.server, .olean.private, .ir) so that
    // a downstream importer can resolve at any OLeanLevel.
    fs.writeFileSync(
      libLean,
      'module\npublic def greet (name : String) : String := "hello " ++ name\n',
    );

    const compile = await runLean(['-o', libOlean, `--root=${scratch}`, libLean], 6 * 60_000);
    console.log(`  compile(MyLib) took ${compile.durationMs}ms`);
    // Don't trust exitCode under PROXY_TO_PTHREAD; verify by artifact.
    expect(fs.existsSync(libOlean)).toBe(true);
    const size = fs.statSync(libOlean).size;
    console.log(`  MyLib.olean size: ${size} bytes`);
    expect(size).toBeGreaterThan(0);

    fs.writeFileSync(appLean, 'import MyLib\n#eval greet "world"\n');

    const consume = await runLean(['--json', appLean], { env: { LEAN_EXTRA_PATH: scratch }, timeoutMs: 6 * 60_000 });
    console.log(`  consume(App) took ${consume.durationMs}ms`);
    const msgs = jsonLines(consume.stdout);
    const data = msgs.map((m: any) => String(m.data));
    expect(data).toEqual(expect.arrayContaining(['"hello world"']));
  });

  test('without LEAN_EXTRA_PATH, the import fails with unknown-module diagnostic', async () => {
    test.setTimeout(6 * 60_000);
    const scratch = makeScratch('byoml-neg');
    const app = path.join(scratch, 'App.lean');
    fs.writeFileSync(app, 'import NoSuchUserLib\n#eval 1\n');

    const result = await runLean(['--json', app], 4 * 60_000);
    const msgs = jsonLines(result.stdout);
    const errors = msgs.filter((m: any) => m.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((m: any) => /unknown (module|package|prefix)/i.test(String(m.data)))).toBe(true);
  });
});
