// End-to-end tests for the React/Redux IDE.
// Tests hit the Node server at :8787, which serves the built IDE at / and
// the compile API at /api/compile. No Vite dev server required for tests.
// For live iteration, run `cd packages/ide && npm run dev` (proxies to :8787).
//
// Run: npx playwright test --project=browser -g 'React IDE'

import { test, expect } from '@playwright/test';

const IDE_URL = '/';

test.describe('React IDE', () => {
  test('menu renders with a default project and Editor/Architecture links', async ({ page }) => {
    await page.goto(IDE_URL);
    await expect(page.getByRole('navigation', { name: 'project menu' }).getByRole('heading', { name: 'Lean IDE' })).toBeVisible();
    // Default scratch project is the selected option in the project dropdown.
    await expect(page.getByRole('combobox', { name: 'select project' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'select project' })).toContainText('scratch');
    // Top-level view links.
    await expect(page.getByRole('link', { name: 'Editor' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Architecture' })).toBeVisible();
  });

  test('new project + rename workflow', async ({ page }) => {
    await page.goto(IDE_URL);
    const select = page.getByRole('combobox', { name: 'select project' });
    // Click "+ new" to add a scratch project; it becomes active.
    await page.getByRole('button', { name: /^\+ new$/ }).click();
    // Two options now in the dropdown.
    await expect(select.locator('option')).toHaveCount(2);
    // Rename via the rename button → input → Enter.
    await page.getByRole('button', { name: /^✎ rename$/ }).click();
    const rename = page.locator('.menu .project-rename');
    await rename.fill('my-project');
    await rename.press('Enter');
    await expect(select).toContainText('my-project');
  });

  test('architecture page renders a mermaid diagram', async ({ page }) => {
    await page.goto(IDE_URL);
    await page.getByRole('link', { name: 'Architecture' }).click();
    await expect(page.getByRole('heading', { name: 'Architecture', level: 1 })).toBeVisible();
    // Wait for the first diagram's SVG to render.
    await expect(page.locator('.arch-page .diagram svg').first()).toBeVisible({ timeout: 10_000 });
    // Should have all 5 diagrams authored: system, compile flow, grammar
    // pipeline, redux, in-browser wasm status.
    await expect(page.locator('.arch-page .diagram svg')).toHaveCount(5, { timeout: 15_000 });
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
    // Use server mode for compile assertions: browser-mode (in-page WASM)
    // is the new default but its diagnostic relay is the skipped path
    // (see ide-compile-mode.spec.ts). Server mode is fully working.
    await page.locator('.compile-mode select').selectOption('server');
    await page.evaluate(() => (window as any).__ideEditor.setValue('#eval 1 + 1\n'));
    // Wait until the editor's content matches what we set (onChange fired)
    // AND the editor-wide re-render has settled.
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
    // Server-mode for diagnostic assertions (browser-mode default's
    // pthread output relay is the skipped path).
    await page.locator('.compile-mode select').selectOption('server');
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
    // v4.27 wording: `Unknown identifier \`badname\`` (capital U, backticks).
    // Earlier Lean versions used `unknown identifier 'badname'`. Match either.
    await expect(diag.locator('.diag-msg')).toContainText(/[Uu]nknown identifier [`']badname[`']/);
    // Location badge shows 1:17.
    await expect(diag.locator('.loc')).toHaveText('1:17');

    // Click the diag; cursor should jump to the referenced position.
    // Verify by reading back what the editor holds — the line should still be
    // visible and the click should not have altered content.
    await diag.locator('.diag-jump').click();
    const val = await page.evaluate(() => (window as any).__ideEditor.getValue());
    expect(val).toContain('badname');
  });

  test('Lean syntax highlighting is active', async ({ page }) => {
    await page.goto(IDE_URL);
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });
    // CM6 emits highlighted token spans inside .cm-line under .cm-content;
    // class names are ͼ-prefixed by the default highlight style. The exact
    // class names aren't asserted here — only that some highlighted spans
    // exist for the default Lean source.
    const tokenSpans = await page.locator('.cm-content .cm-line span').count();
    expect(tokenSpans).toBeGreaterThan(0);
  });

  test('Cancel button aborts an in-flight compile', async ({ page }) => {
    test.setTimeout(2 * 60_000);
    await page.goto(IDE_URL);
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });
    // Server mode: cancel via fetch's AbortController is the proven path;
    // browser-mode cancel routes through the worker postMessage protocol
    // and is gated on the same pthread relay as the skipped compile test.
    await page.locator('.compile-mode select').selectOption('server');
    await page.evaluate(() => (window as any).__ideEditor.setValue('#eval 1 + 1\n'));
    await page.waitForTimeout(200);

    await page.getByRole('button', { name: /^compile/i }).first().click();

    // Status flips to 'running' → cancel button appears.
    await expect(page.locator('.pane-header .status.running')).toBeVisible({ timeout: 20_000 });
    const cancelBtn = page.getByRole('button', { name: /^cancel$/i });
    await expect(cancelBtn).toBeVisible();

    // Click cancel; status should return to 'idle' quickly (fetch aborts, thunk rejects AbortError).
    await cancelBtn.click();
    await expect(page.locator('.pane-header .status.running')).not.toBeVisible({ timeout: 15_000 });
    // Compile button is back.
    await expect(page.getByRole('button', { name: /^compile/i })).toBeVisible();
  });

  test('Inline diagnostic markers appear after a compile error', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await page.goto(IDE_URL);
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });
    // Server mode for the marker assertion (browser mode's diagnostic
    // relay is the skipped path).
    await page.locator('.compile-mode select').selectOption('server');
    await page.evaluate(() => (window as any).__ideEditor.setValue('def foo : Nat := badname\n'));
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /compile/i }).first().click();
    await expect(page.locator('.pane-header .status.fail')).toBeVisible({ timeout: 4 * 60_000 });
    const markerCount = await page.evaluate(() => (window as any).__ideEditor.getMarkers().length);
    expect(markerCount).toBeGreaterThan(0);
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
