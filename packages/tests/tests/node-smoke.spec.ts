// Node-side tests for the Lean-in-WASM harness.
// These spawn the trace_fs.js harness as a child process and assert on output.
// Each test gets a fresh Lean instance (no shared-state cross-talk).

import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { runLean, SAMPLES } from './_lib/spawn.js';

test.describe('node harness: core smoke', () => {
  test('lean --version reports Lean 4.15.0', async () => {
    const { stdout, exitCode, durationMs } = await runLean(['--version']);
    console.log(`  --version took ${durationMs}ms`);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Lean \(version 4\.15\.0/);
  });

  test('trivial compile (no stdlib import) evaluates correctly', async () => {
    const file = path.join(SAMPLES, 'Trivial.lean');
    const { stdout, exitCode, durationMs } = await runLean([file]);
    console.log(`  Trivial.lean took ${durationMs}ms`);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('42');
  });

  test('stdlib compile: import Std + arithmetic', async () => {
    const file = path.join(SAMPLES, 'Smoke.lean');
    const { stdout, exitCode, durationMs } = await runLean([file], 4 * 60_000);
    console.log(`  Smoke.lean took ${durationMs}ms`);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('"hello from wasm"');
    expect(stdout).toContain('45');
    expect(stdout).toContain('4950');
  });
});

test.describe('node harness: error surfacing', () => {
  test('reports unreachable input file', async () => {
    const { exitCode, stderr } = await runLean(['/Users/nonexistent-' + Date.now() + '.lean']);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/(not found|no such)/);
  });

  test('reports syntax error in input', async () => {
    const file = path.join(SAMPLES, 'Syntax.lean');
    // Create an intentionally broken file for this assertion, inline, so
    // we don't pollute the samples dir with deliberately-bad fixtures.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = path.join(os.tmpdir(), `lean-syntax-${Date.now()}.lean`);
    // /tmp doesn't work due to harness mount quirk; write under /Users.
    const userTmp = path.join(process.cwd(), '.pw-syntax-tmp.lean');
    try {
      fs.writeFileSync(userTmp, 'def foo : Nat := (\n');
      const { exitCode, stderr } = await runLean([userTmp]);
      expect(exitCode).not.toBe(0);
      expect(stderr.length).toBeGreaterThan(0);
    } finally {
      try { fs.unlinkSync(userTmp); } catch {}
    }
  });
});
