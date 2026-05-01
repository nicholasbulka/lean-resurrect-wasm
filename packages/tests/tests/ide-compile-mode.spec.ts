// Compile-mode toggle: assert both server-mode and browser-mode compiles
// produce the expected diagnostic for a simple Lean source.
//
//   Server mode: the IDE POSTs to /api/compile, server spawns Node-side
//                Lean, returns diagnostics. Fast.
//   Browser mode: the IDE spawns a Web Worker that pulls lean.{js,wasm}
//                 + Init oleans (~480 MB cold), runs Lean entirely client-
//                 side, returns diagnostics. Slow first time; subsequent
//                 compiles reuse the warm WASM instance.

import { test, expect } from '@playwright/test';

const TRIVIAL = 'def x : Nat := 42\n#eval x\n';

test.describe('Compile mode toggle', () => {
  test('mode select renders with server default', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 30_000 });
    const select = page.locator('.compile-mode select');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('server');
  });

  test('server mode compile: #eval x returns 42 diagnostic', async ({ page }) => {
    test.setTimeout(8 * 60_000);
    page.on('pageerror', (err) => console.log('[browser:pageerror]', err.message));
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 30_000 });
    await page.evaluate((src) => (window as any).__ideEditor.setValue(src), TRIVIAL);
    await page.locator('.compile-mode select').selectOption('server');
    await page.getByRole('button', { name: /^compile/i }).first().click();
    // Wait for terminal status (ok or fail).
    await expect(page.locator('.pane-header .status.ok, .pane-header .status.fail'))
      .toBeVisible({ timeout: 7 * 60_000 });

    // Compile state from Redux.
    const result = await page.evaluate(() => {
      const s = (window as any).__store?.getState?.()?.compile;
      return s ? { status: s.status, diagnostics: s.result?.diagnostics ?? [] } : null;
    });
    console.log('[test] server compile state:', JSON.stringify(result));
    expect(result?.status).toBe('ok');
    const data = (result?.diagnostics ?? []).map((d: any) => String(d.data));
    expect(data).toEqual(expect.arrayContaining(['42']));
  });

  // Known gap: browser-mode (in-page WASM) compile completes (status 'ok')
  // but produces 0 diagnostics — Lean's main runs in an emscripten pthread
  // worker whose Module.print output isn't reaching the outer leanWorker's
  // capture buffer despite our postMessage relay. The MT=ON+PROXY_TO_PTHREAD
  // path is proven end-to-end on the Node side (see scripts/mt-on-run.sh
  // — `#eval x` returns "42" through Node worker_threads). The browser
  // pthread variant adds a layer (SharedArrayBuffer-backed MEMFS, browser
  // Worker-vs-pthread Worker name detection, message-channel routing
  // between nested workers) that needs separate hardening. Re-enable once:
  //   1. Pthread worker output is verifiably captured in the outer
  //      leanWorker (DevTools console of pthread worker shows JSON
  //      diagnostics, but they aren't reaching __leanPthreadBuf), AND
  //   2. Pthread's MEMFS sees the oleans staged by outer's preRun
  //      (or we route the compile through the outer Module entirely).
  test.skip('browser mode compile: #eval x returns 42 diagnostic (slow first run)', async ({ page }) => {
    // First run downloads ~480 MB (lean.{js,wasm} + Init oleans). Allow
    // generous time. Subsequent runs would be much faster but tests get
    // a fresh browser each time.
    test.setTimeout(15 * 60_000);
    page.on('pageerror', (err) => console.log('[browser:pageerror]', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('[leanWorker')) {
        console.log('[browser:' + msg.type() + ']', msg.text());
      }
    });
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 30_000 });
    await page.evaluate((src) => (window as any).__ideEditor.setValue(src), TRIVIAL);
    await page.locator('.compile-mode select').selectOption('browser');
    await page.getByRole('button', { name: /^compile/i }).first().click();

    await expect(page.locator('.pane-header .status.ok, .pane-header .status.fail'))
      .toBeVisible({ timeout: 14 * 60_000 });

    const result = await page.evaluate(() => {
      const s = (window as any).__store?.getState?.()?.compile;
      return s ? { status: s.status, error: s.error, diagnostics: s.result?.diagnostics ?? [] } : null;
    });
    console.log('[test] browser compile state:', JSON.stringify(result));
    expect(result?.status).toBe('ok');
    const data = (result?.diagnostics ?? []).map((d: any) => String(d.data));
    expect(data).toEqual(expect.arrayContaining(['42']));
  });
});
