# Option A — `uv_spawn` shim for in-WASM Lean LSP (foundation, 2026-06-13)

Goal: let Lean's `--server` watchdog "fork" its `--worker` elaboration
subprocesses inside the WASM sandbox, so we get a persistent, incremental
in-browser LSP (hover / goto-def / goal-state / fast re-elaborate) instead
of the per-compile spawn model.

This document is the **foundation** for that multi-session effort: the
confirmed protocol, the corrected hook mechanism, the pipe design, the
staged plan, and the open risks. No rebuilds were run to produce it.

## State of the world (confirmed this session)

- `lean --server` boots in our WASM and handles **one-shot** LSP fine
  (initialize → full capabilities). Proven earlier (`spike.cjs`).
- The **JSPI build** (`build-wasm/stage1/bin/lean-jspi-pt.{js,wasm}`,
  USE_PTHREADS + JSPI, no PROXY_TO_PTHREAD) solved continuous stdin via
  `fd_read` suspension and reaches the real wall:
- **Wall: `uv_spawn`.** After `didOpen` the watchdog spawns a `--worker`
  subprocess; Emscripten can't fork → `ENOSYS` (errno 52) → watchdog exits.
- The current *production* binary (MT=ON+PROXY) hits the earlier stdin wall
  (`ESPIPE`, error 29) — it is NOT the LSP foundation; the JSPI build is.

## The watchdog↔worker protocol is just LSP-over-pipe (de-risked)

`vendor/lean4-src/src/Lean/Server/Watchdog.lean:875-911` — `startFileWorker`:
```
Process.spawn { cmd := workerPath, args := #["--worker"] ++ st.args ++ #[uri],
                stdin := piped, stdout := piped, stderr := inherit, setsid := true }
... then over the worker's stdin pipe:
fw.stdin.writeLspRequest      ⟨0, "initialize", st.initParams⟩
fw.stdin.writeLspNotification { method := "textDocument/didOpen", ... }
```
So the watchdog drives the worker with **standard LSP frames over a pipe**,
and `forwardMessages` shuttles bytes between client↔watchdog↔worker. The
shim therefore does **not** need to understand the protocol — it only has to
transport bytes faithfully between two virtualized pipes. Lean's own
watchdog + worker speak LSP to each other.

## MILESTONE 1a RESULT (2026-06-13): wrap-uv_spawn is the WRONG hook

Relinked the JSPI+pthread binary with `-Wl,--wrap=uv_spawn` + the EM_JS shim
(`docker/relink-jspi-pt-shim.sh`, link-only, ~works). Drove `--server`
through `didOpen` (`spike-fdread.cjs` on `lean-jspi-pt-shim.js`):
initialize → capabilities → didOpen → fileProgress → **`error code 52`** —
but `[uv-spawn-shim] __wrap_uv_spawn intercepted` **never logged**. The wrap
caught nothing because **Lean's WASM spawn path doesn't call `uv_spawn`**.

Source proof (`vendor/lean4-src/src/runtime/process.cpp`): `#if LEAN_WINDOWS`
(CreateProcess) `#else` … `#endif` — the POSIX `#else` branch is what
emscripten compiles, and it spawns with raw **`fork()` (line 445) +
`execvp()` (line 504)**. Emscripten stubs `fork` → ENOSYS → `throw errno`
(line 447) → the watchdog's "error code 52".

**You cannot shim `fork()`** (can't duplicate a wasm instance). So the
interception MUST be at the whole-spawn-function level:

### CORRECTED-AGAIN mechanism: patch `lean_io_process_spawn`
Patch the static `spawn(...)` / `lean_io_process_spawn` (process.cpp:437/552)
so that under emscripten it does NOT fork/exec but instead (via EM_JS):
1. launches a Web Worker / worker_thread running the same wasm with argv
   `[procName, ...args]` (the watchdog passes `["--worker", ...st.args, uri]`),
2. creates stdin/stdout pipe fds backed by SAB ring buffers, returns the
   child object (`mk_cnstr(0, parent_stdin, parent_stdout, parent_stderr, ...)`
   + pid + setsid byte) exactly as the fork path does — so the watchdog's
   subsequent `fdopen`/read/write on those fds Just Work.
The hard sub-problem becomes: wire those returned fds to the SAB pipes at
the emscripten FS layer so `fdopen()` + libc read/write reach the worker.
This is a **Lean source patch + full rebuild** (closer to Option B, but
surgical — only `spawn`, keeping the watchdog/worker split intact), NOT a
libuv wrap. `uv-spawn-shim.c` / `--wrap` are dead ends; keep for the record.

## MILESTONE 1b-i RESULT (2026-06-13): source hook FIRES, argv captured

Patched `process.cpp` spawn with an `EM_JS` probe (`scripts/patch-lsp-spawn.js`)
+ full rebuild (`scripts/docker-relink-jspi-pt.sh`, ~25 min). Drove `--server`
past `didOpen`:
```
[spawn-probe] cmd=.../bin/lean args=--worker inmemory:///main.lean
Watchdog error: ... (error code: 52)   ← still the unpatched fork() below
```
The probe fired at exactly the watchdog's worker-spawn site (where --wrap was
silent), confirming the source-patch hook is correct, and captured the exact
argv: `--worker <uri>` (plus `st.args` when a project is open). The watchdog
then dies at the still-unpatched fork() — as designed for 1b-i.

The probe delegates to `Module.__leanSpawnWorker(cmd, args)`, so the actual
Web-Worker launch + SAB pipe wiring is now iterable IN JS with no rebuild.

## MILESTONE 1b-ii RESULT (2026-06-17): return-path FIRES, watchdog drives worker stdin

Rewrote `patch-lsp-spawn.js` to the return-path version: under `__EMSCRIPTEN__`,
spawn calls `int lean_em_spawn(cmd,args)` → `Module.__leanSpawnWorker(cmd,args)`,
which returns `{pid,inFd,outFd,errFd}`; fds read back via `lean_em_last_fd(which)`
(pointer-free ABI). If pid>0 the runtime builds the SAME child object the fork
path builds (`mk_cnstr(0, parent_stdin, parent_stdout, parent_stderr,
sizeof(pid_t)+sizeof(uint8_t))` + `cnstr_set_uint32` pid + `cnstr_set_uint8`
setsid) and RETURNs, skipping fork; else falls through. Full rebuild via
`scripts/docker-relink-jspi-pt.sh` (ccache → ~few min, not 25).

Validated with `tools/lsp-spike/spike-spawn-smoke.cjs`, which stubs
`__leanSpawnWorker` to hand back real (empty) MEMFS fds + a fake pid:
```
[smoke] __leanSpawnWorker FIRED cmd=.../bin/lean args="--worker\ninmemory:///main.lean\n"
[smoke] returning inFd=8 outFd=9
worker stdin bytes written by watchdog: 443
worker stdin preview: Content-Length: 134 ... "method":"initialize" ... "method":"textDocument/didOpen" ...
Watchdog error: Cannot read LSP message: Stream was closed   ← EXPECTED (empty outFd → EOF)
```
- spawn return-path fires; **NO error 52** (fork bypassed);
- child object is correct — the watchdog `fdopen(inFd,"w")` + wrote 443 bytes of
  valid LSP frames (`initialize`, then `didOpen`) into the worker's stdin, exactly
  per `Watchdog.lean:875-911`;
- the trailing "Stream was closed" exit is correct: the stub's outFd is an empty
  MEMFS file, so the watchdog's read of the worker reply hits EOF. No real worker yet.

**The C++ side of Option A is DONE.** Everything remaining is rebuild-free JS.

### TWO OPERATIONAL GOTCHAS (cost real debugging — do not relearn)
1. **Node flag.** This glue needs the NEW JSPI API (`WebAssembly.Suspending`):
   run `node --experimental-wasm-jspi --max-old-space-size=10240` (Node 24).
   Without it: "WebAssembly.Suspending is not a constructor". (`stack-switching`
   alone also boots but is the older flag.) pthread Workers inherit `process.execArgv`,
   so the flag propagates to the pool automatically.
2. **No idle gap after `initialize`.** The watchdog exits (ExitStatus 1) if left
   idle after responding to `initialize`. Send `initialize` → `initialized` →
   `didOpen` BACK-TO-BACK with no `await`/delay between them, or it dies before the
   worker spawn. (A 1500ms gap reproduced the spontaneous "onExit status=undefined".)

### Next: milestone 1b-iii — real worker + SAB pipes (rebuild-free JS)
Build `Module.__leanSpawnWorker` for real. In JS (`Module.__leanSpawnWorker`):
1. `new Worker` running the same wasm with the captured `--worker` argv
   (reuse the leanWorker bootstrap: NODEFS/MEMFS, oleans, JSPI fd hooks);
2. allocate SAB ring-buffer pipes (`sab-pipe.mjs`) and register emscripten FS
   fds backed by them, returning those fd numbers — THE CRUX: the watchdog's
   `fdopen()`+read/write on the returned fds must reach the worker. Two routes:
   (a) register a custom FS device whose read/write drive the SAB (cleanest),
   (b) point libuv/the fd at an emscripten pipe and bridge to SAB.
3. the spawned worker reads/writes ITS stdin/stdout via the same JSPI fd_read/
   fd_write hook, bound to the other end of the SAB pipes.

## (superseded) CORRECTED hook mechanism — link-level uv_spawn wrap

Originally assumed: "override the `uv_spawn` import in JS, like `fd_read`."
**This is infeasible.** Evidence (against `lean-jspi-pt.js`):
- `_uv_spawn` / `_posix_spawn` are `wasmExports["uv_spawn"]` etc. — compiled
  INTO the wasm, not JS imports. Reassigning the JS wrapper does NOT catch
  internal wasm→wasm calls (Lean runtime → libuv `uv_spawn` is wasm-internal).
- There are **no** process syscalls as JS functions: `fork`, `execve`,
  `clone`, `__syscall_clone`, `__emscripten_fork` are all absent. Only
  FS/socket `__syscall_*` exist. So `posix_spawn` bottoms out in compiled
  musl returning ENOSYS — there is no JS syscall to intercept either.

**Real mechanism: a link-level override.** Provide our own `uv_spawn`
(and the minimal libuv process/pipe surface) in a linked C object that the
linker resolves ahead of libuv's, implemented with `EM_JS` so it calls out
to JS. That JS launches a Web Worker (browser) / worker_thread (Node)
running the same `lean.wasm` with `--worker` argv, and wires the worker's
stdin/stdout to SharedArrayBuffer pipes the watchdog's pipe fds read/write.
This needs a **rebuild** (via the existing `docker/relink-jspi-pt.sh` plus
the shim object), not a runtime patch.

## Architecture

```
 client (IDE)  ──LSP──▶  [watchdog wasm]  ──LSP-over-SAB-pipe──▶  [worker wasm (Web Worker)]
       ▲                      │  uv_spawn(EM_JS) ───────────────────▶ spawn Worker(--worker uri)
       └───────LSP────────────┘  uv_pipe read/write ⇄ SAB ring buffers ⇄ worker stdin/stdout
```
- Both watchdog and worker do I/O via the **proven JSPI `fd_read`/`fd_write`
  suspension** (`spike-fdread.cjs`) over SAB ring buffers.
- `uv_spawn` shim: allocate two SAB ring buffers (w→worker stdin, worker→w
  stdout), start a Worker with the same wasm + `['--worker', ...args, uri]`,
  return a fake pid + wire the libuv pipe handles to the SABs.
- Also shim (minimal): `uv_pipe_*` read/write to the SABs, `uv_process_kill`
  / `uv_signal_*` / `uv_kill` → terminate the Worker (setsid:=true wants a
  killable session). `uv_process_get_pid` → the fake pid.

## Staged plan (multi-session; ~1-2 weeks, rebuild-bound)

1. **Single-worker shim, Node first.** Link a `uv_spawn` EM_JS override that
   spawns ONE worker_thread; virtualize the two pipes via SAB. Drive with
   the existing JSPI fd I/O on both sides. Target: watchdog gets past
   `didOpen`, worker elaborates, a hover/goal response returns. (Several
   25-min relinks expected — budget 4-8.)
2. **Lifecycle + cancellation.** `uv_process_kill`/signals → terminate the
   worker; restart-on-crash (FileWorker.forceExit codes 1/2 at
   `FileWorker.lean:398,1094`); multiple files → multiple workers.
3. **Browser port.** worker_thread → Web Worker; confirm SAB + Atomics +
   COOP/COEP (already set) + nested-Worker spawn from a Worker.
4. **IDE wiring.** Persistent session, CM6 hoverTooltip / goal panel, on
   `didChange` debounce. Reuses the closure-prefetch staging for the worker's
   olean FS.

## Open risks / unknowns

- **Nested Workers from a pthread Worker.** The watchdog runs under
  USE_PTHREADS; spawning a Web Worker from within may need care
  (Emscripten's own pthread pool also uses Workers).
- **Per-worker olean FS.** Each worker needs the same `/lean/lib/lean`
  staging; reuse closure-prefetch (core staged once, demand-paging for the
  rest) per worker. Memory: N workers × ~1 GB each — tight on a 4 GB
  wasm32 browser tab; may need to cap concurrent workers.
- **setsid / signals semantics** under the shim are approximate.
- **Link precedence**: confirm our `uv_spawn` wins over libuv's (libuv is a
  static archive; provide the object before it, or `--allow-multiple-definition`
  / wrap via `-Wl,--wrap=uv_spawn`). `--wrap` may be the cleanest hook and
  avoids editing libuv source.

## Scaffold in this directory

- `uv-spawn-shim.c` — skeleton C override (EM_JS) + the `--wrap` approach.
- `sab-pipe.mjs` — SharedArrayBuffer ring-buffer pipe (producer/consumer with
  Atomics) shared by host + worker sides.
Both are starting points, not yet wired to a build.
