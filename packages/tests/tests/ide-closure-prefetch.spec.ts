// Closure-prefetch end-to-end (browser mode): the proof that the IDE can
// compile a real Mathlib file in-browser by staging a fixed ~782 MB core
// (closure of Mathlib.Init) plus only the file's per-import delta — WITHOUT
// staging all ~4 GB of Mathlib, which exceeds the wasm32 MEMFS ceiling.
//
// Two cases:
//   1. Core-only file (Mathlib.Data.Real.Basic, delta 0): proves the core
//      base layer alone lets Lean elaborate a Mathlib import in-browser.
//   2. Small-delta file (Mathlib.Algebra.Group.Shrink, delta 3): proves the
//      per-file delta is fetched + staged. Because `import X` loads X's full
//      olean closure, a missing delta olean fails the import outright — so a
//      clean elaboration IS the proof the delta staged correctly.
//
// This is heavy: first compile downloads lean.{js,wasm} (~258 MB) + stdlib
// oleans (~227 MB) + the 782 MB core. Generous timeouts; browser tests get a
// fresh page so the core is re-imported per test.

import { test, expect } from '@playwright/test';

const MATHLIB_SLUG = 'mathlib-v4.27.0-2026-04';

// A core-only Mathlib file: Real.Basic is wholly inside the Init core (delta 0).
const CORE_ONLY = 'import Mathlib.Data.Real.Basic\n#check (1 : ℝ)\n';
// A small-delta Mathlib file: Group.Shrink pulls 3 modules beyond the core.
const SMALL_DELTA = 'import Mathlib.Algebra.Group.Shrink\nexample : True := trivial\n';

function wireDiagnostics(page: import('@playwright/test').Page) {
  page.on('pageerror', (err) => console.log('[browser:pageerror]', err.message));
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error' || t.includes('[leanWorker') || t.includes('[ide]')) {
      console.log('[browser:' + msg.type() + ']', t);
    }
  });
}

// Drive ProjectMenu.importFromCdn: it calls prompt() once for the slug pick.
async function importMathlibFromCdn(page: import('@playwright/test').Page) {
  page.on('dialog', (d) => {
    // The slug-pick prompt; any stray alert() (errors) we also dismiss so the
    // test surfaces the failure via assertions rather than hanging.
    if (d.type() === 'prompt') d.accept(MATHLIB_SLUG);
    else d.dismiss().catch(() => {});
  });
  await page.getByRole('button', { name: /from CDN/i }).click();
  // Import completes when the current project is the Mathlib slug and its
  // oleans bundles (the core shards) are staged in the side-table.
  await page.waitForFunction((slug) => {
    const st = (window as any).__store?.getState?.();
    const id = st?.projects?.currentId;
    const proj = id ? st.projects.entities[id] : null;
    return !!proj && proj.root && String(proj.root).includes(slug);
  }, MATHLIB_SLUG, { timeout: 8 * 60_000 });
}

async function compileAndGet(page: import('@playwright/test').Page, source: string) {
  await page.evaluate((src) => (window as any).__ideEditor.setValue(src), source);
  await page.locator('.compile-mode select').selectOption('browser');
  await page.getByRole('button', { name: /^compile/i }).first().click();
  await expect(page.locator('.pane-header .status.ok, .pane-header .status.fail'))
    .toBeVisible({ timeout: 18 * 60_000 });
  return page.evaluate(() => {
    const s = (window as any).__store?.getState?.()?.compile;
    return s ? { status: s.status, error: s.error ?? null, diagnostics: s.result?.diagnostics ?? [] } : null;
  });
}

function assertNoOleanErrors(result: any) {
  const msgs = (result?.diagnostics ?? []).map((d: any) => String(d.data ?? d.message ?? ''));
  const bad = msgs.filter((m: string) => /does not exist|unknown (module|package|constant|identifier)|incompatible header/i.test(m));
  expect(bad, `unexpected import/olean errors: ${JSON.stringify(bad)}`).toHaveLength(0);
}

test.describe('closure-prefetch: in-browser Mathlib compile under the 4 GB ceiling', () => {
  // Baseline: a trivial non-Mathlib compile must work end-to-end in browser
  // mode (init + stdlib staging + real elaboration → exit). Isolates "Mathlib
  // is just slow" from "browser compile is broken" if the heavy tests fail.
  test('baseline: trivial in-browser compile returns 42', async ({ page }) => {
    test.setTimeout(8 * 60_000);
    wireDiagnostics(page);
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 30_000 });
    const result = await compileAndGet(page, 'def x : Nat := 42\n#eval x\n');
    console.log('[test] baseline compile:', JSON.stringify(result));
    expect(result?.status).toBe('ok');
    const data = (result?.diagnostics ?? []).map((d: any) => String(d.data));
    expect(data).toEqual(expect.arrayContaining(['42']));
  });

  test('core-only file (Real.Basic, delta 0) elaborates from the staged core', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    wireDiagnostics(page);
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 30_000 });

    await importMathlibFromCdn(page);
    const result = await compileAndGet(page, CORE_ONLY);
    console.log('[test] core-only compile:', JSON.stringify(result));

    expect(result?.status).toBe('ok');
    assertNoOleanErrors(result);
    // #check (1 : ℝ) should surface an info diagnostic mentioning the real type.
    const data = (result?.diagnostics ?? []).map((d: any) => String(d.data));
    expect(data.some((d: string) => /ℝ|Real/.test(d))).toBe(true);
  });

  test('small-delta file (Group.Shrink, delta 3) fetches + stages the delta', async ({ page }) => {
    test.setTimeout(25 * 60_000);
    wireDiagnostics(page);
    await page.goto('/');
    await page.waitForFunction(() => (window as any).__ideEditor?.ready === true, null, { timeout: 30_000 });

    await importMathlibFromCdn(page);
    const result = await compileAndGet(page, SMALL_DELTA);
    console.log('[test] small-delta compile:', JSON.stringify(result));

    // The import resolving at all proves the 3 delta oleans were fetched +
    // staged; a missing one would error "object file ... does not exist".
    expect(result?.status).toBe('ok');
    assertNoOleanErrors(result);
  });
});
