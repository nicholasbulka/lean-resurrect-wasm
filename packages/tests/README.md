# Tests

Playwright-based test suite spanning Node-side and browser-side behavior of the Lean-in-WASM harness.

## Running

```sh
npm install
npx playwright install chromium    # first-time only

npx playwright test                  # all projects (~12 min: node is slow)
npx playwright test --project=node   # Node harness only (~11 min, 7 tests)
npx playwright test --project=browser  # Browser-side only (~18s, 6 tests)
```

## Layout

```
package.json           # @playwright/test
playwright.config.ts   # projects + webServer
server.js              # static server with COOP/COEP + proper MIME; starts on :8787
public/
  index.html           # browser harness page
  harness.js           # Emscripten Module config for browser
tests/
  _lib/spawn.ts        # runLean() helper: spawns a subprocess of trace_fs.js
  node-smoke.spec.ts   # --version, trivial + stdlib compile, error surfaces
  node-determinism.spec.ts  # same input → same output across runs
  node-memory.spec.ts  # peak HEAP8 < 3 GiB gate
  node-byoml.spec.ts   # compile user lib, consume via LEAN_EXTRA_PATH
  node-olean-resolver.spec.ts  # fetch-on-miss + cache: resolver stages oleans lazily
  browser-smoke.spec.ts  # page load, COOP/COEP, MIME, Node-only limitation
```

## Harness env-var knobs

The harness (`preflight/trace_fs.js`) accepts three env vars that drive the two design patterns:

| env var | purpose |
|---|---|
| `LEAN_EXTRA_PATH` | Colon-separated user library roots. Prepended to LEAN_PATH so BYOML libs shadow stdlib. |
| `LEAN_PATH_OVERRIDE` | Fully replace LEAN_PATH (used by tests that want explicit empty paths). |
| `LEAN_RESOLVER_JS` | Path to a CommonJS module that exports `{ resolve(path): Uint8Array \| null }`. Installed as an `FS.stat` / `FS.open` interceptor: on ENOENT for a `.olean`, invoke the resolver and stage returned bytes in the VFS, then retry. Models browser olean-on-demand. |

## Current state (v4.15.0 baseline)

**Node: 7 pass / 0 fail.** Lean runs end-to-end under Node. `--version` is fast (~3s); stdlib compiles take 60–100s because `-DMMAP=OFF` forces olean reloads.

**Browser: 4 pass / 0 fail / 2 skip.** Infrastructure works (COOP/COEP → `crossOriginIsolated=true`, SharedArrayBuffer available, MIME correct). The WASM module does instantiate and pthreads spin up, but Lean's CLI driver aborts at `ASM_CONSTS[685112]` with the documented `"The Lean command-line driver can only run under Node.js"` check. The two skipped tests (actual browser execution) are unblocked once Phase 2 produces a `lean_wasm.cpp`-based browser build.

## Adding browser Lean execution (Phase 2 entry point)

When a browser-capable WASM drops, flip the skipped tests:

```diff
- test.skip('lean --version prints version string in-browser', ...
+ test('lean --version prints version string in-browser', ...
```

And in `browser-smoke.spec.ts`, update the Node-only limitation test to assert the positive case:

```ts
expect(state).toBe('running');
expect(errors).not.toContain('Node.js');
```

## Known quirks hit while building this

- **`page.goto('/*.wasm')` triggers a Chrome download.** For asserting wasm MIME/headers, use `request.get()` instead.
- **`/tmp` doesn't work as a Lean input location** (macOS symlink to `/private/tmp`, interacts with NODEFS). Tests use `/Users`-rooted paths. Tracked in task #9.
- **Test input files should live outside the harness dir** to avoid VFS path drift; all samples are under `preflight/leantest/`.
