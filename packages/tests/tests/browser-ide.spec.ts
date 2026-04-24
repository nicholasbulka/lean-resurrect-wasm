// End-to-end IDE test: open /ide.html in Chrome, type Lean source, click
// Compile, see the output. Exercises the Monaco editor + /api/compile
// endpoint + the Node WASM harness all together.

import { test, expect } from '@playwright/test';

test('Lean IDE: type source, click Compile, see output', async ({ page }) => {
  test.setTimeout(5 * 60_000);

  await page.goto('/ide.html');
  // Monaco loads via CDN; wait for it to initialize.
  await page.waitForFunction(() => typeof (window as any).editor !== 'undefined', null, { timeout: 60_000 });

  // Replace the default sample with a tiny program.
  await page.evaluate(() => (window as any).editor.setValue('#eval 1 + 1\n'));

  await page.click('#run');

  // Compile can take 60-120s; generous timeout on output presence.
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#out-status')?.textContent || '';
      return /exit\s+\d/.test(status);
    },
    null,
    { timeout: 4 * 60_000 },
  );

  const status = (await page.locator('#out-status').textContent()) ?? '';
  const output = (await page.locator('#output').textContent()) ?? '';
  console.log(`  status: ${status}`);
  console.log(`  output: ${output}`);

  expect(status).toMatch(/exit 0/);
  expect(output).toContain('2');
});
