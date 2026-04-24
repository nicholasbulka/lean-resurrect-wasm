// End-to-end tests for the React/Redux IDE.
// Tests hit the Node server at :8787, which serves the built IDE at / and
// the compile API at /api/compile. No Vite dev server required for tests.
// For live iteration, run `cd packages/ide && npm run dev` (proxies to :8787).
//
// Run: npx playwright test --project=browser -g 'React IDE'

import { test, expect } from '@playwright/test';

const IDE_URL = '/';

test.describe('React IDE', () => {
  test('menu renders with a default proof and Editor/Architecture links', async ({ page }) => {
    await page.goto(IDE_URL);
    await expect(page.getByRole('navigation', { name: 'proof menu' }).getByRole('heading', { name: 'Lean IDE' })).toBeVisible();
    // One default proof ("scratch") is visible as a tab.
    await expect(page.locator('.menu .tab.active')).toContainText('scratch');
    // Top-level view links.
    await expect(page.getByRole('link', { name: 'Editor' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Architecture' })).toBeVisible();
  });

  test('new proof + rename workflow', async ({ page }) => {
    await page.goto(IDE_URL);
    // Add a new proof.
    await page.locator('.menu button[title="new proof"]').click();
    // Should now be two tabs; the new one is active.
    const tabs = page.locator('.menu .tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveClass(/active/);
    // Rename it by double-clicking.
    await tabs.nth(1).dblclick();
    const rename = page.locator('.menu .inline-rename');
    await rename.fill('my-proof');
    await rename.press('Enter');
    await expect(page.locator('.menu .tab.active')).toContainText('my-proof');
  });

  test('architecture page renders a mermaid diagram', async ({ page }) => {
    await page.goto(IDE_URL);
    await page.getByRole('link', { name: 'Architecture' }).click();
    await expect(page.getByRole('heading', { name: 'Architecture', level: 1 })).toBeVisible();
    // Wait for the first diagram's SVG to render.
    await expect(page.locator('.arch-page .diagram svg').first()).toBeVisible({ timeout: 10_000 });
    // Should have at least the 4 diagrams authored (system, compile flow,
    // redux, in-browser wasm status).
    await expect(page.locator('.arch-page .diagram svg')).toHaveCount(4, { timeout: 15_000 });
  });

  test('design pane renders user-authored mermaid live', async ({ page }) => {
    await page.goto(IDE_URL);
    // Switch to Design tab.
    await page.getByRole('button', { name: 'Design' }).click();
    // Wait for the default mermaid diagram to render.
    await expect(page.locator('.design-preview svg').first()).toBeVisible({ timeout: 10_000 });
  });

  test('compile: type Lean, click compile, get output', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await page.goto(IDE_URL);

    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });
    await page.evaluate(() => (window as any).__ideEditor.setValue('#eval 1 + 1\n'));
    // Wait until Monaco's content matches what we set (onChange fired) AND
    // until the editor-wide re-render has settled.
    await page.waitForFunction(
      () => (window as any).__ideEditor.getValue().trim() === '#eval 1 + 1',
      null, { timeout: 5_000 }
    );
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: /compile/i }).first().click();

    await expect(page.locator('.pane-header .status.ok')).toBeVisible({ timeout: 4 * 60_000 });
    // --json formats #eval output as an info diagnostic, not plain stdout.
    await expect(page.locator('.diag.sev-info .diag-msg').first()).toContainText('2');
  });

  test('compile with a syntax error surfaces a structured diagnostic', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await page.goto(IDE_URL);
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });
    await page.evaluate(() => (window as any).__ideEditor.setValue('def foo : Nat := badname\n'));
    await page.waitForFunction(
      () => (window as any).__ideEditor.getValue().includes('badname'),
      null, { timeout: 5_000 }
    );
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: /compile/i }).first().click();

    // Wait for compile to exit with an error status.
    await expect(page.locator('.pane-header .status.fail')).toBeVisible({ timeout: 4 * 60_000 });
    // Diagnostic row should appear.
    const diag = page.locator('.diag.sev-error').first();
    await expect(diag).toBeVisible();
    await expect(diag.locator('.diag-msg')).toContainText("unknown identifier 'badname'");
    // Location badge shows 1:17.
    await expect(diag.locator('.loc')).toHaveText('1:17');

    // Click the diag; cursor should jump to the referenced position in Monaco.
    // Verify by reading back what the editor holds — the line should still be
    // visible and the click should not have altered content.
    await diag.locator('.diag-jump').click();
    const val = await page.evaluate(() => (window as any).__ideEditor.getValue());
    expect(val).toContain('badname');
  });

  test('BYOML: library-paths editor adds, renders, and persists paths', async ({ page }) => {
    await page.goto(IDE_URL);
    // Add two paths.
    const addInput = page.locator('.lib-paths-row input').last();
    await addInput.fill('/tmp/my-lib-A');
    await page.locator('.lib-paths-row button', { hasText: '+' }).first().click();
    await addInput.fill('/tmp/my-lib-B');
    await page.keyboard.press('Enter');
    // Both visible.
    const inputs = page.locator('.lib-paths-row input');
    await expect(inputs.nth(0)).toHaveValue('/tmp/my-lib-A');
    await expect(inputs.nth(1)).toHaveValue('/tmp/my-lib-B');
    // Reload: they persist.
    await page.reload();
    const inputsAfter = page.locator('.lib-paths-row input');
    await expect(inputsAfter.nth(0)).toHaveValue('/tmp/my-lib-A');
    await expect(inputsAfter.nth(1)).toHaveValue('/tmp/my-lib-B');
    // Remove the first one.
    await page.locator('.lib-paths-row button[title="remove"]').first().click();
    const inputsFinal = page.locator('.lib-paths-row input');
    await expect(inputsFinal.nth(0)).toHaveValue('/tmp/my-lib-B');
  });
});
