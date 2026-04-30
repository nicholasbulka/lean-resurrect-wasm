// Diagnostic test: load Lean in-browser, dump state of FS + ENV + Module
// after preRun, then run a small compile and dump stdout/stderr/exit.
// Used to debug the "Lean returns exit 0 in 3ms with no output" mystery.

import { test, expect } from '@playwright/test';

test.skip('diagnose in-browser Lean startup + minimal compile', async ({ page }) => {
  test.setTimeout(120_000);
  const browserLogs: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    browserLogs.push(`[${msg.type()}] ${t}`);
  });
  page.on('pageerror', (err) => browserLogs.push(`[pageerror] ${err.message}`));

  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 20_000 });

  // Trigger ensureLeanLoaded by switching to browser mode + running a noop compile.
  await page.evaluate(() => (window as any).__ideEditor.setValue('-- empty\n'));
  await page.locator('.compile-mode select').selectOption('browser');

  // Probe Module state via window.__leanWasmState (we'll set this).
  const probeBefore = await page.evaluate(async () => {
    const mod = (window as any).Module;
    return mod ? { hasModule: true, hasFS: !!mod.FS, hasENV: !!mod.ENV, hasCallMain: typeof mod.callMain } : { hasModule: false };
  });
  console.log('[probe-before]', JSON.stringify(probeBefore));

  // Click compile to load WASM + run.
  await page.getByRole('button', { name: /^compile/i }).first().click();

  // Wait for any non-running status.
  await expect(
    page.locator('.pane-header .status.ok, .pane-header .status.fail')
  ).toBeVisible({ timeout: 90_000 });

  // Now Module is loaded. Probe FS + ENV.
  const probe = await page.evaluate(async () => {
    const mod = (window as any).Module;
    if (!mod || !mod.FS) return { error: 'no Module.FS' };
    const FS = mod.FS;
    const ENV = mod.ENV || {};
    const ls = (path: string) => {
      try { return FS.readdir(path).filter((n: string) => !n.startsWith('.')); }
      catch (e: any) { return `<err: ${e.message}>`; }
    };
    const stat = (path: string) => {
      try { const s = FS.stat(path); return { mode: s.mode.toString(8), size: s.size }; }
      catch (e: any) { return `<err: ${e.message}>`; }
    };
    const exists = (path: string) => {
      try { FS.stat(path); return true; } catch { return false; }
    };
    return {
      env_keys: Object.keys(ENV).slice(0, 30),
      LEAN_PATH: ENV.LEAN_PATH,
      LEAN_SYSROOT: ENV.LEAN_SYSROOT,
      LEAN_EXTRA_PATH: ENV.LEAN_EXTRA_PATH,
      ls_root: ls('/'),
      ls_lib: ls('/lib'),
      ls_lib_lean: ls('/lib/lean'),
      ls_work: ls('/work'),
      input_lean_exists: exists('/work/Input.lean'),
      input_lean_stat: stat('/work/Input.lean'),
      init_olean_exists: exists('/lib/lean/Init.olean'),
      callMain: typeof mod.callMain,
    };
  });
  console.log('[probe-after-compile]', JSON.stringify(probe, null, 2));

  // Dump compile state.
  const compileState = await page.evaluate(() => {
    const s = (window as any).__store?.getState?.()?.compile;
    return s ? { status: s.status, error: s.error, result: s.result } : null;
  });
  console.log('[compile-state]', JSON.stringify(compileState, null, 2));

  // Run a fresh callMain manually with print/printErr capture, just to see
  // if direct invocation produces different output than the slice path.
  const directRun = await page.evaluate(async () => {
    const mod = (window as any).Module;
    if (!mod?.callMain) return { error: 'no callMain' };
    let stdout = '', stderr = '';
    mod.print = (...a: unknown[]) => { stdout += a.join(' ') + '\n'; };
    mod.printErr = (...a: unknown[]) => { stderr += a.join(' ') + '\n'; };
    try {
      mod.FS.writeFile('/work/Input.lean', new TextEncoder().encode('#eval 1 + 1\n'));
    } catch (e: any) {
      return { error: 'write failed: ' + e.message };
    }
    const t0 = Date.now();
    let exit: number;
    try {
      exit = mod.callMain(['--version']);
    } catch (e: any) {
      return { phase: '--version', error: e.message ?? String(e) };
    }
    return { phase: 'done', t: Date.now() - t0, exit, stdout, stderr };
  });
  console.log('[direct-version]', JSON.stringify(directRun, null, 2));

  // Print all browser logs at end, in-order.
  console.log('=== ALL BROWSER LOGS ===');
  for (const l of browserLogs) console.log(l);
});
