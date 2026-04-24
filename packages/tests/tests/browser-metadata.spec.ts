// End-to-end: metadata commands that actually work in-browser.
// Everything here passes against v4.15.0 CLI WASM with the harness shims.
import { test, expect } from '@playwright/test';

async function runArgs(page: any, args: string, opts: { seed?: string } = {}) {
  const lines: string[] = [];
  page.on('console', (m: any) => lines.push(m.text()));
  const qs = new URLSearchParams({ args });
  if (opts.seed) qs.set('seed', opts.seed);
  await page.goto('/debug?' + qs.toString());
  await page.waitForTimeout(opts.seed ? 10_000 : 5_000);
  const out = (await page.locator('#out').textContent()) ?? '';
  return { out, lines };
}

test('lean --version prints the version', async ({ page }) => {
  test.setTimeout(30_000);
  const { out } = await runArgs(page, '--version');
  expect(out).toMatch(/Lean \(version 4\.15\.0/);
});

test('lean --help prints the help text', async ({ page }) => {
  test.setTimeout(30_000);
  const { out } = await runArgs(page, '--help');
  expect(out).toContain('--version');
  expect(out).toContain('--print-libdir');
  expect(out).toContain('--threads=num');
});

test('lean --print-libdir shows /lib/lean', async ({ page }) => {
  test.setTimeout(30_000);
  const { out } = await runArgs(page, '--print-libdir');
  expect(out).toMatch(/stdout:\s*\/lib\/lean/);
});

test('seed=init: 234 Init oleans fetch, stage, and --version still works', async ({ page }) => {
  test.setTimeout(60_000);
  const { out } = await runArgs(page, '--version', { seed: 'init' });
  expect(out).toMatch(/seeding 234 oleans .*~86 MiB/);
  expect(out).toMatch(/staged 234 oleans into \/lib\/lean\/ in \d+ms/);
  expect(out).toMatch(/Lean \(version 4\.15\.0/);
});

test.skip('compile a Lean file end-to-end (KNOWN LIMITATION)', async () => {
  // v4.15.0 CLI WASM hangs when asked to compile a .lean file in browser.
  // Elaboration enters a code path that deadlocks or crashes silently.
  // The shims get us past startup (process, NODEFS, __filename), but the
  // elaborator itself has unfixable browser-incompatibility. Getting this
  // to work would require upstream changes to the WASM build (e.g. a
  // browser-oriented entry point like the dead src/shell/lean_js.cpp,
  // rewritten against current Lean 4 APIs) or a thread-model fix.
});
