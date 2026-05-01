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

// Both BYOML tests depend on LEAN_PATH being honored at lean_main startup.
// In v4.27 WASM with PROXY_TO_PTHREAD=1 the ENV-propagation that the
// upstream lean.cpp EM_ASM does (process.env["LEAN_PATH"] → ENV) was
// stripped by our patch alongside the CLI node-check, AND the pthread
// worker that runs lean_main has its own fresh closure-scoped var ENV
// that our preRun setting doesn't reach. Net: only the install-prefix
// search path is consulted. Re-enable when we either (a) restore the
// ENV propagation in patch-leanjs.js with a worker-aware path, or (b)
// rebuild Lean with init_search_path reading LEAN_PATH directly.
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
