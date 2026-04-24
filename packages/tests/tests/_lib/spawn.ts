import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(__dirname, '../../../..');
export const HARNESS = path.join(WORKSPACE, 'preflight/trace_fs.js');
export const SAMPLES = path.join(WORKSPACE, 'preflight/leantest');

export interface LeanResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface RunOptions {
  /** Extra env vars overlaid on process.env. Use for LEAN_EXTRA_PATH, LEAN_PATH_OVERRIDE, LEAN_RESOLVER_JS. */
  env?: Record<string, string>;
  /** Hard kill after this many ms. */
  timeoutMs?: number;
}

export function runLean(args: string[], optsOrTimeout: RunOptions | number = {}): Promise<LeanResult> {
  const opts: RunOptions = typeof optsOrTimeout === 'number' ? { timeoutMs: optsOrTimeout } : optsOrTimeout;
  const timeoutMs = opts.timeoutMs ?? 8 * 60_000;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn('node', ['--stack-size=8192', HARNESS, ...args], {
      cwd: WORKSPACE,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`runLean timeout after ${timeoutMs}ms; args=${JSON.stringify(args)}`));
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode: code ?? -1, durationMs: Date.now() - started });
    });
    proc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}
