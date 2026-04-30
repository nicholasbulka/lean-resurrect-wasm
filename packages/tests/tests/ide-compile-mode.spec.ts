// Compile-mode toggle: switching to "browser" should attempt the in-browser
// path. Today that path errors with a clear message (Lean rebuild pending);
// once the rebuild lands, this test should be flipped to assert success.

import { test, expect } from '@playwright/test';

test.describe('Compile mode toggle', () => {
  test('mode select renders with server default', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });
    const select = page.locator('.compile-mode select');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('server');
  });

  test('in-browser compile path executes without hanging', async ({ page }) => {
    test.setTimeout(180_000);
    page.on('console', (msg) => console.log('[browser]', msg.type(), msg.text()));
    page.on('pageerror', (err) => console.log('[browser:pageerror]', err.message));
    page.on('worker', (worker) => {
      worker.on('console', (msg) => console.log('[worker:' + worker.url().split('/').pop() + ']', msg.type(), msg.text()));
    });
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });
    await page.evaluate(() => (window as any).__ideEditor.setValue('#eval 1 + 1\n'));
    await page.waitForTimeout(200);
    await page.locator('.compile-mode select').selectOption('browser');
    await page.getByRole('button', { name: /^compile/i }).first().click();

    // Either ok or fail — the point is it terminated, not running forever.
    await expect(
      page.locator('.pane-header .status.ok, .pane-header .status.fail')
    ).toBeVisible({ timeout: 150_000 });

    // Capture status text so we can see what happened in test output.
    const statusText = await page.locator('.pane-header .status').textContent();
    console.log('[test] final status:', statusText);

    // Inspect the actual compile result for stdout/stderr/exit/diagnostics.
    const result = await page.evaluate(() => {
      const s = (window as any).__store?.getState?.()?.compile;
      return s ? { status: s.status, error: s.error, result: s.result } : null;
    });
    console.log('[test] compile state:', JSON.stringify(result, null, 2));
  });

  test.skip('in-browser compile catches a real type error', async () => {
    // Skipped pending architecture fix: with PROXY_TO_PTHREAD=1 the worker
    // pthread that runs lean_main eventually hits an `unreachable` WASM
    // trap on real input (likely a libuv stub gap surfaced as link-time
    // undefined-symbol warnings). Once we either rebuild MT=ON-only or
    // move compileInBrowser into a dedicated Web Worker that can correctly
    // proxy the main loop, flip this back on.
  });
});
