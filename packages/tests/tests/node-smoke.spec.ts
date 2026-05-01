// Node-side smoke for v4.27 MT=ON WASM Lean.
//
// These tests spawn the patched lean.js via preflight/trace_fs.js. Each
// test gets a fresh Lean instance (no shared-state cross-talk).
//
// Notes on assertions:
//   - We don't assert exitCode === 0. Lean's `--version` ends with `throw 0`
//     in Lean code; that 0 propagates fine to native Lean's exit, but goes
//     through PROXY_TO_PTHREAD's worker→main exit path under WASM and
//     surfaces as 224 in our harness. The version banner IS in stdout,
//     so we assert on content.
//   - With `--json`, all diagnostics (parse + elab errors) come on stdout
//     as one JSON object per line. We parse and assert on shape.
//   - Imports of Std are slow (~2min cold start). Most tests use Init-only
//     fixtures to keep the suite under 5min.
import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { runLean, SAMPLES } from './_lib/spawn.js';

function jsonLines(stdout: string): any[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{') && s.endsWith('}'))
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
}

test.describe('node harness: metadata', () => {
  test('--version reports Lean 4.27.0', async () => {
    const { stdout, durationMs } = await runLean(['--version']);
    console.log(`  --version took ${durationMs}ms`);
    expect(stdout).toMatch(/^Lean \(version 4\.27\.0/);
    expect(stdout).toContain('wasm32-unknown-emscripten');
  });

  test('--print-libdir resolves to install dir', async () => {
    const { stdout, durationMs } = await runLean(['--print-libdir']);
    console.log(`  --print-libdir took ${durationMs}ms`);
    expect(stdout.trim()).toMatch(/lib\/lean$/);
  });
});

test.describe('node harness: compile + #eval', () => {
  test('Trivial.lean: #eval prints 42', async () => {
    const file = path.join(SAMPLES, 'Trivial.lean');
    const { stdout, durationMs } = await runLean(['--json', file], 4 * 60_000);
    console.log(`  Trivial.lean took ${durationMs}ms`);
    const msgs = jsonLines(stdout);
    const evals = msgs.filter((m) => m.severity === 'information');
    expect(evals.length).toBeGreaterThan(0);
    expect(evals.some((m: any) => m.data === '42')).toBe(true);
  });

  test('Smoke.lean: import Std + arithmetic produces expected #eval results', async () => {
    const file = path.join(SAMPLES, 'Smoke.lean');
    const { stdout, durationMs } = await runLean(['--json', file], 6 * 60_000);
    console.log(`  Smoke.lean took ${durationMs}ms`);
    const msgs = jsonLines(stdout);
    const data = msgs.map((m: any) => String(m.data));
    expect(data).toEqual(expect.arrayContaining(['"hello from wasm"']));
    expect(data).toEqual(expect.arrayContaining(['45']));    // sumTo 10
    expect(data).toEqual(expect.arrayContaining(['4950']));  // sumTo 100
  });
});

test.describe('node harness: error surfacing', () => {
  test('unreachable input file produces a clear error', async () => {
    const phantom = '/Users/nonexistent-' + Date.now() + '.lean';
    const { stdout, stderr } = await runLean([phantom]);
    const all = (stdout + stderr).toLowerCase();
    expect(all).toMatch(/(not found|no such)/);
  });

  test('syntax error: --json emits a structured error diagnostic', async () => {
    // Write to a path the harness can mount (under cwd, not /tmp).
    const userTmp = path.join(process.cwd(), '.pw-syntax-tmp.lean');
    try {
      fs.writeFileSync(userTmp, 'def foo : Nat := (\n');
      const { stdout } = await runLean(['--json', userTmp], 4 * 60_000);
      const msgs = jsonLines(stdout);
      const errors = msgs.filter((m: any) => m.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
      // The exact wording can change between releases; assert on parser
      // intent rather than verbatim text.
      expect(errors.some((m: any) => /unexpected|expected/i.test(String(m.data)))).toBe(true);
    } finally {
      try { fs.unlinkSync(userTmp); } catch {}
    }
  });
});
