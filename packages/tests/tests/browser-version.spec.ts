// Does `lean --version` actually produce the version string in the browser?
// This test flips the skipped Phase-2 test into a live assertion now that
// the browser harness shims process + NODEFS.

import { test, expect } from '@playwright/test';

test('lean --version runs in-browser and prints the version string', async ({ page }) => {
  test.setTimeout(120_000);

  const consoleLines: string[] = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));

  await page.goto('/debug');
  // Wait for either runtime init complete, abort, or the stdout appearing.
  await page.waitForFunction(
    () => {
      const s = (window as any).__leanState;
      const out = document.querySelector('#out')?.textContent || '';
      return out.includes('Lean (version') || s === 'aborted' || s === 'scriptError';
    },
    null,
    { timeout: 90_000 },
  );

  const outText = await page.locator('#out').textContent() ?? '';
  const state = await page.evaluate(() => (window as any).__leanState);
  const errs = await page.evaluate(() => ((window as any).__leanErrors || []).join(' | '));

  console.log(`  state=${state}`);
  console.log(`  errors=${errs || '(none)'}`);
  console.log(`  #out length=${outText.length}`);
  const tail = outText.slice(-600);
  console.log(`  #out tail:\n${tail}`);

  expect(state).toBe('running');
  expect(outText).toMatch(/Lean \(version 4\.15\.0/);
});
