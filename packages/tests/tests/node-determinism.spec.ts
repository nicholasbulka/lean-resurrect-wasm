// Determinism regression: the same input should produce the same output
// across runs. If a future change introduces non-determinism in the WASM
// build or harness, this flags it.

import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { runLean, SAMPLES } from './_lib/spawn.js';

test.describe('node harness: determinism', () => {
  test('Smoke.lean --json stdout is identical across two consecutive runs', async () => {
    const file = path.join(SAMPLES, 'Smoke.lean');
    const r1 = await runLean(['--json', file], 6 * 60_000);
    const r2 = await runLean(['--json', file], 6 * 60_000);
    // Don't trust exitCode under PROXY_TO_PTHREAD; ensure non-empty stdout
    // (proves both runs actually executed the elaborator).
    expect(r1.stdout.length).toBeGreaterThan(0);
    expect(r2.stdout).toBe(r1.stdout);
    console.log(`  run1=${r1.durationMs}ms run2=${r2.durationMs}ms`);
  });
});
