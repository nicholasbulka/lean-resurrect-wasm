// Memory regression. Delegates to preflight/p1_memory.js which logs a
// "[p1] peak HEAP8.length = ..." line to stderr. We parse that line and
// assert the peak stays under a gate.
//
// This is a regression test: a future change that significantly grows
// memory usage on the canonical workload will trip this.

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '../../..');
const P1 = path.join(WORKSPACE, 'preflight/p1_memory.js');
const INPUT = path.join(WORKSPACE, 'preflight/leantest/Linarith.lean');

function runP1(timeoutMs = 8 * 60_000): Promise<{stdout: string; stderr: string; exitCode: number}> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['--stack-size=8192', P1, INPUT], { cwd: WORKSPACE });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('p1 timeout')); }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(t); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
    proc.on('error', e => { clearTimeout(t); reject(e); });
  });
}

test('P1 memory probe: peak HEAP8 stays under 3 GiB on stdlib-heavy workload', async () => {
  test.setTimeout(15 * 60_000);
  const { stderr } = await runP1(12 * 60_000);
  // Don't trust exitCode under PROXY_TO_PTHREAD; the probe always logs the
  // peak on process exit, so just parse stderr.
  const m = stderr.match(/\[p1\] peak HEAP8\.length = (\d+) bytes/);
  expect(m, 'p1 probe did not log peak').not.toBeNull();
  const peak = Number(m![1]);
  const peakGiB = peak / 1024 / 1024 / 1024;
  console.log(`  peak = ${peakGiB.toFixed(3)} GiB`);
  expect(peak).toBeLessThan(3 * 1024 * 1024 * 1024);
});
