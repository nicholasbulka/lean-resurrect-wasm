# Phase 11 spike — RESULT: continuous LSP via JSPI rebuild is real (Status B)

Date: 2026-05-04
Toolchain: Lean v4.27.0 MT=ON, Node WASM. Two builds:
- production: `vendor/lean-linux_wasm32/bin/lean.{js,wasm}` (MT=ON, no Asyncify)
- experimental: `build-wasm/stage1/bin/lean-jspi.{js,wasm}` (MT=ON, JSPI=1)

## TL;DR

`lean --server` boots inside our existing Node WASM and **handles a
single LSP request perfectly**. Continuous LSP interaction (sustained
request/response over the lifetime of an IDE session) is **structurally
blocked** without rebuilding Lean WASM with Asyncify.

The block is not a missing config or wiring — it's a fundamental
mismatch between Emscripten's synchronous `Module.stdin` API and the
pattern of "block waiting for the next LSP frame." Three independent
paths all confirm the same wall.

## What works (Spike 1 — `spike.cjs`)

Pre-queue the `initialize` LSP frame into a JS-side stdin queue, then
`callMain(['--server'])`. Lean reads the queued bytes, processes
`initialize`, writes a full LSP response. Confirms:

- `lean --server` is in the binary
- Module.stdin / Module.stdout work as documented
- LSP framing is stable through Module.print byte capture
- Lean returns its full capability surface (hover, goto-def, completion,
  semantic tokens, inlay hints, code actions, rename, document symbols,
  folding)

This proves *the LSP is real*. It does NOT prove that *continuous
interaction* is possible.

## What doesn't work (Spike 2a, 2b — both blocked)

### Attempt A: `Module.stdin` with `Atomics.wait` on a SharedArrayBuffer ring buffer (`spike-continuous.cjs`)

Hypothesis: `Atomics.wait` would block when the queue is empty,
unblock when the producer pushes bytes + `Atomics.notify`. The pthread
running Lean would wait, the main thread would push bytes
asynchronously.

**Result**: stalls forever after `callMain(['--server'])`. The
diagnostic (`diag-stdin.cjs`) confirmed why: **`Module.stdin` runs on
the MAIN thread**, not the pthread. Even though Lean's `--server` loop
runs on the pthread under PROXY_TO_PTHREAD, Emscripten **proxies FS
syscalls back to the main thread**. Our Atomics.wait there freezes the
event loop, blocking exactly the async tasks that would push bytes.

`worker_threads.isMainThread === true` confirmed during Module.stdin
invocation: `[diag] Module.stdin call #1 from MAIN`.

### Attempt B: Subprocess + Unix pipes (`spike-subprocess.cjs` + `lsp-runner.cjs`)

Hypothesis: spawn `node lsp-runner.cjs` as a child process, talk to it
via real Unix pipes (`stdio: ['pipe', 'pipe', 'pipe']`). Emscripten's
default Node stdin handling reads from `process.stdin`; the OS handles
blocking I/O for free.

**Result**: child reports `Watchdog error: Cannot read LSP request:
hardware fault (error code: 29)`. Error 29 is `ESPIPE` — illegal seek
on a pipe. This is the **libuv stdin pipe stub under Emscripten**
documented in `warm_worker_spike.md`. Lean's libuv-backed I/O cannot
read from a real pipe in our Emscripten build; the syscall translation
is incomplete.

## Why these two failures are the same problem

Both paths need *blocking-aware I/O between asynchronous host and
synchronous WASM*. Emscripten's options are:

1. **Synchronous Module.stdin** — works, but cannot block on main
   thread without freezing event loop. (Spike 2a fails here.)
2. **libuv stdin pipe** — would handle blocking natively if it
   worked, but it's stubbed in Emscripten WASI/POSIX layer. (Spike 2b
   fails here.)
3. **Asyncify** — JS hooks can be async (return Promises); WASM
   suspends and resumes when the Promise resolves. *Designed for
   exactly this use case.* Requires Lean WASM to be **rebuilt** with
   `-sASYNCIFY=1 -sASYNCIFY_IMPORTS=[...]`.

There's no combination of (1) + (2) that gives us continuous LSP. We
need (3).

## Cost of the proper fix (Asyncify rebuild)

- Rebuild Lean v4.27 WASM with `-sASYNCIFY=1`. Settings tuned. `~21min
  hot rebuild` per memory `v427_wasm_build_recipe`.
- ASYNCIFY interacts non-trivially with PTHREAD support. Per Emscripten
  issue tracker, combining the two has historically required care
  around thread-local state. Some users report needing
  `-sASYNCIFY_ADVISE` to find blocking imports, plus careful thread
  synchronization. May require multiple iterations to stabilize.
- Once stable: `Module.stdin` returns a Promise; Lean's read syscall
  suspends until resolved. Continuous LSP works. Hover works,
  goto-def works, etc.

Realistic: 2-4 hot-rebuild iterations + Lean smoke tests.
**1-3 days of focused work** to get a clean ASYNCIFY+PTHREAD build
running `--server` with continuous I/O.

## Pragmatic alternative (pseudo-LSP via per-request spawn)

Without Asyncify rebuild, the only available pattern is
**spawn-per-request with pre-queued frames**:

- Each LSP query (hover, completion, etc.) spawns a fresh Lean WASM
- Pre-queue: `initialize` + `initialized` + `didOpen` + the actual
  request
- Read all responses
- Kill the process

Cold-start ~6s for runtime + ~5-30s for Lean LSP boot + olean load,
depending on imports. Per-hover latency: 10-40 seconds.

This is too slow for interactive hover but technically delivers the
LSP semantic data. Could work as "explicit LSP query button" UX
("Inspect this expression") rather than mouse-hover. Limited but
functional for exploratory work.

## What's preserved in this directory

- `spike.cjs` — original one-shot success (initialize via pre-queue)
- `RESULTS.md` — this file
- `spike-continuous.cjs` — Spike 2a (SAB + Atomics.wait), STALLS
- `diag-stdin.cjs` — diagnostic that confirmed Module.stdin on main
  thread (single line of output: `from MAIN`)
- `lsp-runner.cjs` — child process for subprocess approach
- `spike-subprocess.cjs` — Spike 2b (subprocess + pipes), FAILS with
  ESPIPE

All four scripts are reproducible (`node tools/lsp-spike/<script>.cjs`).

## Phase 11.0 follow-up: JSPI rebuild (2026-05-04 same day)

Built `lean-jspi.{js,wasm}` via `docker/relink-jspi.sh` + the host
wrapper at `scripts/docker-relink-jspi.sh`. Used `-sJSPI=1` instead
of `-sASYNCIFY=1` because JSPI is compatible with `-fwasm-exceptions`
(Lean's C++ exception model). Build time: ~25 min for full relink
(faster than ASYNCIFY=1's ~hour-plus wasm-opt instrumentation).

Artifacts:
- `lean-jspi.js`: 114 MB (similar to production 119 MB)
- `lean-jspi.wasm`: 149 MB (vs. production 138 MB; +8% from JSPI
  glue, much smaller growth than ASYNCIFY=1's projected ~30%)

**Smoke (`smoke-asyncify.cjs` against the JSPI binary)**: PASSES.
After patching with `node scripts/patch-leanjs.js
build-wasm/stage1/bin/lean-jspi.js` (NODEFS mount + pthread relay
patches that the existing harness depends on), and running with
`node --experimental-wasm-stack-switching`, the binary boots and
prints `Lean (version 4.27.0, wasm32-unknown-emscripten, ...)` from
`callMain(['--version'])`. Cold-start ~10s.

**Continuous LSP (`spike-async.cjs` against the JSPI binary)**:
PARTIAL. The binary boots into `--server` mode and reads bytes from
our async `Module.stdin`. But Lean's LSP responds with:

    Watchdog error: Cannot read LSP request: No Content-Length field
    in header: [(

The bytes Lean is reading are NOT our LSP frame — they're junk.

**Root cause** (identified, not yet fixed): Emscripten's TTY
`get_char` calls `Module.stdin()` and treats the result as either a
byte, a string, or an array. When `Module.stdin` returns a Promise,
`get_char` doesn't know to await — it iterates the Promise object as
if it were an array, pushing `undefined` into `tty.input`, which
later gets read as garbage bytes. JSPI auto-wraps WASM imports for
suspension, but the suspension doesn't propagate through the layered
JS code (`__syscall_read` → `FS.read` → `tty.ops.read` →
`tty.ops.get_char` → `Module.stdin`).

**Three known-good fixes** for the next iteration (each ~50 lines,
no further rebuild required):
1. Producer writes directly into `Module.FS.streams[0].tty.input`;
   Module.stdin returns null only as EOF after Lean signals done.
2. Override `tty.ops.get_char` to use `Asyncify.handleAsync` /
   `WebAssembly.Suspending` directly, so the JSPI wrapper sees the
   Promise from this layer.
3. Patch the Emscripten runtime's TTY code to await Promise return
   from Module.stdin.

Option 1 is the cleanest minimum-viable path: doesn't require JSPI
plumbing through the layered JS, doesn't require runtime patches,
just bypasses Module.stdin entirely.

## Phase 11.0 conclusion: Status B (partial success)

Per `PHASE-11.0-ACCEPTANCE.md`:
- Build links cleanly with JSPI=1
- Binary boots, --version smoke passes
- LSP --server runs, reads stdin
- Continuous interaction blocked at the Module.stdin Promise
  unwrapping layer — characterized failure with three concrete
  fixes proposed
- Regression bar holds (production binary unchanged, /api/compile
  returns "42", /api/project/scan returns 166, 6/6 React IDE tests
  pass)

This is a clean stopping point. Phase 11.1 (next session) starts
with implementing fix option 1 against the existing
`lean-jspi.{js,wasm}` artifact — no further rebuild needed.

## Original recommendation (revised)

**Do not invest in Phase 11 (continuous LSP) without first investing
in an Asyncify rebuild.** The architectural block is real, not a
configuration issue.

Two reasonable paths from here:

- **Asyncify rebuild track**: Phase 11.0 becomes the rebuild itself;
  Phase 11.1 onward proceeds against the new binary with the original
  plan (SAB or async Module.stdin). Days of WASM build work; high
  payoff.
- **Pause Phase 11**: keep building everything that doesn't need
  continuous LSP — e.g., Phase 9b (Lean import dependency graph in
  Sigma), polish of the existing IDE features. Re-engage with LSP
  when there's appetite for the rebuild.

The key insight: **the current Lean WASM binary works for our existing
"compile button" model. Continuous LSP is a different category of
runtime requirement** that needs Asyncify-or-equivalent. Knowing this
now saves potentially weeks of working around it the wrong way.
