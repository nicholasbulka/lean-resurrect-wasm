# Phase 11 spike — RESULT: LSP-via-WASM works

Date: 2026-05-04
Toolchain: Lean v4.27.0 MT=ON, Node WASM, no patches.

## Outcome

**`lean --server` boots inside our existing Node WASM and responds to a
fully-formed LSP `initialize` request.** The response includes the entire
Lean LSP capability surface: hover, goto-def, completion, rename, semantic
tokens, inlay hints, code actions, document symbols, folding, references,
declaration, signature help, call hierarchy, color provider.

This is the same WASM binary used for one-shot compile today
(`vendor/lean-linux_wasm32/bin/lean.{js,wasm}`). No rebuild was required.

## How

`spike.cjs`:

1. Sets `Module.stdin` / `Module.stdout` / `Module.stderr` to byte-level
   queue functions (Emscripten's documented hook for byte-level I/O).
2. Pre-queues the `initialize` LSP frame into `stdinQueue` BEFORE calling
   `Module.callMain(['--server'])`.
3. Calls `callMain(['--server'])` — async-returning under PROXY_TO_PTHREAD.
4. Polls `stdoutBytes` for `Content-Length:`-framed LSP responses.

The pre-queue is what made it work. Without it, Lean's LSP boots, calls
`read(0)`, gets `null` from `Module.stdin` (because the queue is empty
at that instant), interprets the null as EOF, and exits with stderr:

    Watchdog error: Cannot read LSP request: Stream was closed

With the initialize frame pre-queued, the first stdin read drains the
frame, Lean processes it, and writes the response to stdout. ✓

## What this proves

- The historical block (`warm_worker_spike.md`: "LSP-based worker blocked
  by libuv stdin-pipe stub under Emscripten") is bypassable via Emscripten
  Module hooks. We never used libuv's stdin pipe; we used `Module.stdin`.
- LSP-via-WASM is engineering work, not a research project.
- No patches to Lean were required — current v4.27 binary works.

## Remaining gap (the real Phase 11 work)

The synchronous `Module.stdin` returns `null` to indicate EOF, with no
"would block" sentinel. So *continuous* LSP interaction (where the IDE
sends `didChange`, hover, completion, etc. over the lifetime of the
session) requires Lean's stdin reader to BLOCK when no data is available
— not return EOF.

JS's single-threaded model can't synchronously block. But the pthread
Lean runs on under PROXY_TO_PTHREAD is a real Worker Thread that *can*
block via `Atomics.wait`. The canonical pattern:

- `SharedArrayBuffer` with `[Int32Array(counter), Uint8Array(circular buf)]`
- pthread-side `Module.stdin`:
    if `Atomics.load(counter, 0) === 0`, `Atomics.wait(counter, 0, 0)`
    read next byte from circular buf, decrement counter, return it
- main-side `sendBytes(buf)`:
    copy bytes into circular buf
    `Atomics.add(counter, 0, buf.length)`
    `Atomics.notify(counter, 0)`

That makes WASM-side stdin truly blocking from Lean's POV while the JS
host stays asynchronous. Standard pattern; well-supported in Node Worker
threads (and in browser Web Workers with COOP/COEP, which we already
have configured per the static server).

## Phase 11 plan (validated)

1. Implement SharedArrayBuffer + Atomics.wait stdin queue (Module.stdin
   on pthread side, sender API on main side). ~150 lines.
2. Build a session manager: spawn one Lean LSP instance per IDE session,
   route LSP messages bidirectionally. WebSocket endpoint
   `/api/lsp` between IDE and server is the natural bridge.
3. LSP client in the IDE — minimal initial features (hover, goto-def,
   semantic tokens, document symbols). Each is a single LSP request type
   with a known response shape; the wiring is mechanical once the
   transport works.
4. On-demand semantics commitment (per memory): no `didChange` per
   keystroke; trigger on explicit user actions.

## Repro

    cd /Users/nicholasbulka/prog/lean/wasm
    node --max-old-space-size=10240 tools/lsp-spike/spike.cjs

Expected: `[spike] ✓ SUCCESS — initialize response received.`
Cold-start time on Apple Silicon: ~6s for runtime init, ~few hundred ms
to receive the initialize response after callMain.
