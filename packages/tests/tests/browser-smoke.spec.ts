// Browser harness tests.
//
// The v4.15.0 `lean.wasm` is the CLI driver and has a hardcoded
// `process.release.name !== "node"` assertion (ASM_CONSTS[685112]) that
// deliberately blocks browser execution. Until we rebuild from
// `lean_wasm.cpp` or shim `process`+NODEFS, these tests either:
//   a. Assert the page loads and COOP/COEP plumbing is correct (these pass today)
//   b. Assert on the expected failure mode (these pass today and will
//      need updating once Phase 2 supplies a real browser-capable build)
//   c. Skip with a rationale referencing Phase 2.

import { test, expect } from '@playwright/test';

test.describe('browser harness: infrastructure', () => {
  test('page loads and status element renders', async ({ page }) => {
    await page.goto('/debug');
    await expect(page.locator('h1')).toHaveText('lean-in-wasm');
    await expect(page.locator('#state')).toBeVisible();
  });

  test('COOP/COEP headers make crossOriginIsolated=true', async ({ page }) => {
    await page.goto('/debug');
    // Harness logs the values; we also read them directly.
    await page.waitForFunction(() => typeof (window as any).__crossOriginIsolated === 'boolean');
    const isolated = await page.evaluate(() => (window as any).__crossOriginIsolated);
    const hasSAB = await page.evaluate(() => (window as any).__hasSAB);
    expect(isolated).toBe(true);
    expect(hasSAB).toBe(true);
  });

  test('lean.wasm is served with correct MIME and CORP header', async ({ request }) => {
    // Must use request (not page.goto) because Chrome treats application/wasm
    // as a download during navigation and page.goto would fail with "Download is starting".
    const resp = await request.get('/vendor/bin/lean.wasm');
    expect(resp.status()).toBe(200);
    expect(resp.headers()['content-type']).toBe('application/wasm');
    expect(resp.headers()['cross-origin-resource-policy']).toBe('cross-origin');
  });
});

test.describe('browser harness: shim layer gets Lean running in-browser', () => {
  test('shims pass Node-only assertion without flipping ENVIRONMENT_IS_NODE', async ({ page }) => {
    // Regression test for the shim itself: the Node-only assertion inside
    // ASM_CONSTS[685112] must NOT fire, and no other startup errors should
    // be recorded by the time the runtime reports ready.
    test.setTimeout(120_000);
    await page.goto('/debug');
    await page.waitForFunction(
      () => ['running', 'aborted', 'scriptError'].includes((window as any).__leanState),
      null,
      { timeout: 60_000 },
    );
    const state = await page.evaluate(() => (window as any).__leanState);
    const errors = await page.evaluate(() => ((window as any).__leanErrors || []).join('\n'));
    expect(state).toBe('running');
    expect(errors).not.toContain('Lean command-line driver can only run under Node.js');
  });

  test.skip('trivial Lean file compiles and #eval works in-browser', async ({ page }) => {
    // Requires olean distribution: MEMFS is empty, so Lean cannot find Init.olean.
    // Next step is Phase 3 (serve oleans into MEMFS / OPFS).
  });
});
