# lean-in-wasm workspace

Running Lean 4 + (eventually) Mathlib in WebAssembly. Plan: `~/.claude/plans/silly-wibbling-hellman.md`.

## Status (2026-04-23)

**Phase 2 shipped: React/Redux Lean IDE with server-side compile + Mermaid design tool.**

- **`packages/ide/`** — React 18 + Redux Toolkit + Monaco + Mermaid on Vite. Dev server at `:5173` (proxies `/api` and `/vendor` to `:8787`). Top menu with proof tabs, editor/architecture views, Output/Design right pane split. Proofs persist to localStorage.
- **`packages/tests/public/ide.html`** — legacy vanilla-HTML IDE from the previous step, still works.
- **`/` on :8787** — lower-level WASM harness for experimentation. Buttons for `--version`, `--help`, `--print-libdir`, olean seeding. These commands *do* run Lean WASM in-browser.
- Playwright suite: **15 pass / 2 skip / 0 fail** (~4 min).

**What runs in-browser WASM:** metadata commands (`--version`, `--help`, `--print-libdir`), olean seeding into MEMFS (234 files, 86 MiB in ~1.5 s), pthread workers, SharedArrayBuffer.

**What does NOT run in-browser WASM:** any operation that actually processes a `.lean` file. Both batch compile and `lean --server` (LSP) hang or crash the tab when elaboration starts. Verified empirically; the failure is inside the WASM, unreachable from JavaScript. Needs upstream work to fix — either a new browser-oriented C++ entry point (the one the error message points at, `lean_js.cpp`/`lean_wasm.cpp`, is dead Lean 3 code that doesn't compile against current Lean 4), or an Emscripten build-flag change for pthread pooling. Saved to memory at `browser_compile_hang.md`.

One server, one URL:

```sh
cd packages/ide && npm install && npm run build   # first time only
cd ../tests && node server.js
# open http://localhost:8787
```

`/` serves the built React IDE, `/api/compile` accepts compile requests, `/debug` is the raw WASM harness for experimentation, `/ide.html` is the earlier vanilla Monaco page. Same origin end-to-end — no proxy, no CORS.

For live IDE development:

```sh
cd packages/ide && npm run dev    # Vite at :5173, proxies /api and /vendor to :8787
```



- **Lean 4.15.0 runs in WASM under Node.** `preflight/trace_fs.js` is the working harness; exercises stdlib compile end-to-end.
- **Preflight P1 (memory): PASS.** 0.6 GiB peak on heavy stdlib import. Well under 4 GiB ceiling.
- **Preflight P3 (perf): FAIL.** WASM v4.15 is ~29× slower than native v4.27 for cold-start batch compile. Partly version skew, partly `-DMMAP=OFF` forcing olean reloads.
- **Preflight P1′ (Mathlib Linarith), P2 (libuv stubs), P4 (dlopen SIDE_MODULE): not yet run.**
- **Release channel dropped**: no `linux_wasm32` asset after v4.15.0 (Nov 2024). Current baseline is v4.15.0; future work likely needs a self-built wasm32 Lean against master.

## Layout

```
vendor/
  lean-linux_wasm32/          v4.15.0 release tarball, extracted (879 MB)
  lean-4.15.0-linux_wasm32.tar.zst   original archive (190 MB)
  lean4-src/                  shallow clone of leanprover/lean4 master (reference only)
preflight/
  trace_fs.js                 working Node harness — runs any lean command under WASM
  p1_memory.js                P1: peak HEAP8.length probe
  leantest/                   sample .lean files
packages/                     empty, reserved for Phase 1+
scripts/                      empty
```

## Running Lean in WASM

```sh
cd /Users/nicholasbulka/prog/lean/wasm
node --stack-size=8192 preflight/trace_fs.js --version
node --stack-size=8192 preflight/trace_fs.js preflight/leantest/Linarith.lean
```

Input `.lean` files must live under `/Users/...` (that mount is the harness's workaround; `/tmp` has a mount quirk TBD).

## Gotchas found

1. **lean.js Module pattern fails in Node CJS.** The release uses `var Module = typeof Module != "undefined" ? Module : {}` — in Node, `var Module` is hoisted as local `undefined`, shadowing `globalThis.Module`. Harness works around by reading the source, patching that line in memory, and compiling via `Module._compile`.
2. **WASM build expects `/home` layout.** `ASM_CONSTS[685112]` does `FS.chdir(process.cwd())` at startup; on macOS `process.cwd()` is `/Users/...` which isn't in the default VFS. Harness mounts `/Users` as NODEFS in `preRun` to work around.
3. **`/tmp` paths don't work** despite the runtime mounting `/tmp` as NODEFS. macOS `/tmp` is a symlink to `/private/tmp` — probably interacting with NODEFS's path resolution. Task #9 to investigate.
4. **Stdlib oleans = 512 MiB, not "tens of MB".** Plan was wrong about size.
5. **pthreads are active** in the v4.15.0 release — `lean.worker.js` is loaded on startup. Research had said `MULTI_THREAD=OFF`; that's outdated.
6. **`libleanshared.so` links fine.** Plan note that it doesn't link under WASM is outdated.

## Test suite

`packages/tests/` — Playwright-based, two projects:
- **node** (10 tests, ~16 min): spawns `preflight/trace_fs.js`; asserts `--version`, trivial / stdlib compile, determinism, memory ceiling, error surfaces, **BYOML** (compile-then-consume a custom lib), **olean-on-demand** (fetch-on-miss resolver with cache persistence).
- **browser** (4 pass + 2 skip, ~18s): static server with COOP/COEP → `crossOriginIsolated=true`; documents v4.15 Node-only assertion as the current "browser" behavior; skipped tests awaiting Phase 2 browser-capable build.

```sh
cd packages/tests
npm install
npx playwright install chromium
npx playwright test                 # full suite, ~20 min
npx playwright test --project=node  # node only
npx playwright test -g 'BYOML'      # targeted
```

### BYOML and olean-on-demand

The harness (`preflight/trace_fs.js`) supports two UX patterns via env vars:

- **BYOML** (`LEAN_EXTRA_PATH=/path/to/my/lib`): prepends user libraries to LEAN_PATH. Tested: compile a user lib with WASM Lean, consume via `import` from another file.
- **olean-on-demand** (`LEAN_RESOLVER_JS=/path/to/resolver.cjs`): installs an `FS.stat`/`FS.open` interceptor. On ENOENT for a `.olean`, invokes `resolver.resolve(path) → bytes|null`. If bytes are returned, stages the file in the VFS and retries. Tested: cold cache populated lazily; warm cache is hit (resolver not called); no-resolver case fails clearly. Stdlib is NOT routed through the resolver — Lean's compile-time install-prefix fallback always finds it, which is correct: distribute only user libraries on-demand.

## Not-yet-done (next session)

- P1′: re-run with wasm32 Mathlib oleans (need to find/build them)
- P2: inventory libuv stubs hit during a representative run
- P4: attempt dlopen of a trivial Emscripten SIDE_MODULE
- P5 (new): persistent-worker amortized-perf benchmark — but may require library-mode build first
- Install emsdk, clone Mathlib, build own wasm32 Lean toolchain (for v4.27+ parity)
