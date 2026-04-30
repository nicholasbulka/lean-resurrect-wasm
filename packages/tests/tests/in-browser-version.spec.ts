// Smoke test: does in-browser Lean even survive --version?
// Sends the magic source `@@version` which the worker translates to
// `lean --version` instead of a real compile. If this works, startup
// is sound and any failures on real input are elaboration-side
// (libuv stubs, threading, etc.).

import { test, expect } from '@playwright/test';

test('in-browser lean --version completes', async ({ page }) => {
  test.setTimeout(180_000);
  page.on('console', (msg) => console.log('[browser]', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('[browser:pageerror]', err.message));
  page.on('worker', (worker) => {
    worker.on('console', (msg) => console.log('[worker]', msg.type(), msg.text()));
  });

  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });
  await page.evaluate(() => (window as any).__ideEditor.setValue('@@version\n'));
  await page.locator('.compile-mode select').selectOption('browser');
  await page.getByRole('button', { name: /^compile/i }).first().click();

  await expect(
    page.locator('.pane-header .status.ok, .pane-header .status.fail')
  ).toBeVisible({ timeout: 150_000 });

  const state = await page.evaluate(() => {
    const s = (window as any).__store?.getState?.()?.compile;
    return s ? { status: s.status, error: s.error, result: s.result } : null;
  });
  console.log('[test] compile state:', JSON.stringify(state, null, 2));

  // Real lean --version output starts with "Lean (version".
  expect(state?.result?.stdout || '').toMatch(/Lean \(version/);
});
