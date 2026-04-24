// BYOML ("bring your own mathlib") smoke.
//
// Demonstrates the minimum viable pattern: compile a user library to .olean
// with WASM Lean, then consume it from another file via LEAN_EXTRA_PATH.
// This is the interface any future BYOML UX (file-system-access picker,
// project upload, etc.) ultimately plumbs through.

import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runLean, WORKSPACE } from './_lib/spawn.js';

function makeScratch(name: string): string {
  const dir = path.join(WORKSPACE, '.test-scratch', `${name}-${Date.now()}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test.describe('BYOML: bring-your-own-library in Node', () => {
  test('compile a custom lib, then import it from a consumer file', async () => {
    test.setTimeout(8 * 60_000);
    const scratch = makeScratch('byoml');
    const libLean = path.join(scratch, 'MyLib.lean');
    const libOlean = path.join(scratch, 'MyLib.olean');
    const appLean = path.join(scratch, 'App.lean');

    // 1. User library source. No stdlib import beyond the auto-imported Init.
    fs.writeFileSync(
      libLean,
      'def greet (name : String) : String := "hello " ++ name\n',
    );

    // 2. Compile via WASM Lean.
    const compile = await runLean(['-o', libOlean, `--root=${scratch}`, libLean]);
    console.log(`  compile(MyLib) took ${compile.durationMs}ms`);
    expect(compile.exitCode, compile.stderr).toBe(0);
    expect(fs.existsSync(libOlean)).toBe(true);
    const size = fs.statSync(libOlean).size;
    console.log(`  MyLib.olean size: ${size} bytes`);
    expect(size).toBeGreaterThan(0);

    // 3. Consumer imports the library.
    fs.writeFileSync(appLean, 'import MyLib\n#eval greet "world"\n');

    // 4. Run consumer with the user library on LEAN_PATH.
    const consume = await runLean([appLean], { env: { LEAN_EXTRA_PATH: scratch } });
    console.log(`  consume(App) took ${consume.durationMs}ms`);
    expect(consume.exitCode, consume.stderr).toBe(0);
    expect(consume.stdout).toContain('hello world');
  });

  test('without LEAN_EXTRA_PATH, the import fails clearly', async () => {
    test.setTimeout(4 * 60_000);
    const scratch = makeScratch('byoml-neg');

    // This file imports a module that only exists in a user lib we're
    // NOT putting on LEAN_PATH. Lean should error, not silently accept.
    const app = path.join(scratch, 'App.lean');
    fs.writeFileSync(app, 'import NoSuchUserLib\n#eval 1\n');

    const result = await runLean([app]);
    expect(result.exitCode).not.toBe(0);
    // Lean's wording: "unknown module prefix 'NoSuchUserLib'" or similar.
    expect((result.stderr + result.stdout).toLowerCase()).toMatch(/unknown (module|package|prefix)/);
  });
});
