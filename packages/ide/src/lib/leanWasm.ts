// In-browser Lean WASM wrapper — thin client around a Web Worker that
// owns the WASM lifecycle.
//
// Why a worker:
//   - main thread stays responsive even if Lean blocks
//   - SharedArrayBuffer / Atomics.wait work freely
//   - we can wait for `Module.onExit` synchronously without freezing the UI
//   - sidesteps v4.27's `--entry=_emscripten_proxy_main` (which makes
//     callMain return immediately on the main thread)
//
// The worker (public/leanWorker.js) owns Module + FS + olean staging.
// This file is a thin postMessage adapter that the rest of the IDE keeps
// importing as before (compileInBrowser, ensureLeanLoaded, parseJsonDiagnostics).
//
// Single-flight: only one in-flight compile per worker. Reusing the same
// worker across compiles keeps the WASM warm (memory: warm_worker_spike).

import type { CompileResult, LeanDiagnostic, CompileProgress } from '../slices/compileSlice';

type OnProgress = (p: CompileProgress) => void;
const noopProgress: OnProgress = () => {};

const VENDOR_PREFIX = '/vendor/bin/';
const LEAN_JS_URL = VENDOR_PREFIX + 'lean.js';
const MANIFEST_URL = '/vendor/manifest.json';
const WORKER_URL = '/leanWorker.js';

interface InflightCompile {
  resolve: (r: CompileResult) => void;
  reject: (e: Error) => void;
  onProgress: OnProgress;
}

interface CrossWorkerCache {
  /** Compiled WASM module. JIT-compiled once per page lifetime, transferable
   * between Workers — avoids re-JITing 250MB of bytecode on each respawn. */
  wasmModule: WebAssembly.Module | null;
  /** Olean files fetched from /vendor — keyed by path under /lib/lean. */
  oleans: Array<{ path: string; bytes: Uint8Array }> | null;
  /** Patched lean.js source as a single string. Avoids re-fetch + re-parse
   * across respawns. */
  leanJsSource: string | null;
}

interface WorkerState {
  worker: Worker | null;
  ready: Promise<void> | null;
  // Map requestId → pending compile.
  pending: Map<number, InflightCompile>;
  // Used to surface init failures to any compile already queued.
  initError: Error | null;
  nextRequestId: number;
  /** Cache that survives `disposeLeanWorker` — passed to each new worker. */
  cache: CrossWorkerCache;
  /** Stable per-project core oleans staged at worker INIT (pre-warm), so a
   * compile only pays the per-file delta. Identity in `coreKey`; a changed
   * key (project switch) forces a re-init. */
  coreBundles: Uint8Array[];
  coreKey: string | null;
}

const state: WorkerState = {
  worker: null,
  ready: null,
  pending: new Map(),
  initError: null,
  nextRequestId: 1,
  cache: { wasmModule: null, oleans: null, leanJsSource: null },
  coreBundles: [],
  coreKey: null,
};

function spawnWorker(onProgress: OnProgress): Worker {
  const worker = new Worker(WORKER_URL);
  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'progress': {
        // Forward to whichever compile is currently in-flight, OR to
        // the init-time progress callback if no compile yet.
        const live = nextLiveOnProgress();
        (live ?? onProgress)(m as CompileProgress);
        return;
      }
      case 'ready':
        // Resolved by the init promise via the closure below.
        return;
      case 'init-error': {
        state.initError = new Error('leanWorker init failed: ' + m.error);
        for (const inflight of state.pending.values()) inflight.reject(state.initError);
        state.pending.clear();
        return;
      }
      case 'result': {
        const inflight = state.pending.get(m.requestId);
        if (!inflight) return;
        state.pending.delete(m.requestId);
        inflight.resolve(m.result as CompileResult);
        return;
      }
      case 'error': {
        const inflight = state.pending.get(m.requestId);
        if (!inflight) return;
        state.pending.delete(m.requestId);
        inflight.reject(new Error(m.error));
        return;
      }
      case 'abort': {
        // Lean's onAbort fires asynchronously and isn't tied to a
        // specific requestId. Reject every in-flight compile.
        const err = new Error('Lean WASM aborted: ' + m.what);
        for (const inflight of state.pending.values()) inflight.reject(err);
        state.pending.clear();
        return;
      }
      case 'cache-fill': {
        // The worker shipped back its loaded WASM module + oleans + lean.js
        // source. Stash them so the next worker spawn can skip fetch+JIT.
        if (m.wasmModule && !state.cache.wasmModule) state.cache.wasmModule = m.wasmModule;
        if (m.oleans && !state.cache.oleans) state.cache.oleans = m.oleans;
        if (m.leanJsSource && !state.cache.leanJsSource) state.cache.leanJsSource = m.leanJsSource;
        return;
      }
    }
  };
  worker.onerror = (ev) => {
    const err = new Error('leanWorker error: ' + (ev.message || 'unknown'));
    state.initError = err;
    for (const inflight of state.pending.values()) inflight.reject(err);
    state.pending.clear();
  };
  return worker;
}

function nextLiveOnProgress(): OnProgress | null {
  // Pick the most recent compile's progress callback. We only allow one
  // in-flight at a time so this is well-defined.
  for (const inflight of state.pending.values()) return inflight.onProgress;
  return null;
}

/**
 * Spawn the worker and have it instantiate Lean, stage stdlib oleans, and
 * (if given) pre-stage the project core at init. Reuses an in-flight/ready
 * worker only when it was initialized for the SAME core (`coreKey`); a
 * different key (project switch) tears the old worker down and re-inits.
 */
export function ensureLeanLoaded(
  coreBundles: Uint8Array[] = [],
  coreKey: string | null = null,
  onProgress: OnProgress = noopProgress,
): Promise<void> {
  if (state.ready && state.coreKey === coreKey) return state.ready;
  if (state.ready && state.coreKey !== coreKey) disposeLeanWorker();
  state.coreKey = coreKey;
  state.coreBundles = coreBundles;
  state.worker = spawnWorker(onProgress);
  state.ready = new Promise<void>((resolve, reject) => {
    if (!state.worker) {
      reject(new Error('leanWasm: failed to spawn worker'));
      return;
    }
    const orig = state.worker.onmessage;
    state.worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m?.type === 'ready') {
        resolve();
        // Restore the dispatcher onmessage so subsequent messages flow
        // through the normal path.
        state.worker!.onmessage = orig;
      } else if (m?.type === 'init-error') {
        reject(new Error('leanWorker init failed: ' + m.error));
      } else {
        // Forward init-time progress to the supplied callback.
        if (orig) orig.call(state.worker!, ev);
      }
    };
    // Pass any cached state forward. The compiled WebAssembly.Module
    // structured-clones cheaply (a handle); oleans are NOT cached back (see
    // leanWorker cache-fill — they OOM), so the worker re-fetches the
    // HTTP-cached bundle. initOleansBundles pre-stages the project core so a
    // pre-warmed worker is fully ready for the next compile's delta.
    state.worker.postMessage({
      type: 'init',
      leanJsUrl: LEAN_JS_URL,
      manifestUrl: MANIFEST_URL,
      cachedWasmModule: state.cache.wasmModule,
      cachedOleans: state.cache.oleans,
      cachedLeanJsSource: state.cache.leanJsSource,
      initOleansBundles: coreBundles,
    });
  });
  return state.ready;
}

/**
 * Spawn + initialize a worker (staging the project core) WITHOUT compiling,
 * so the next compile starts warm. Safe to call repeatedly; failures reset
 * the worker so the next compile retries cleanly rather than wedging.
 */
export function prewarmLeanWorker(
  coreBundles: Uint8Array[],
  coreKey: string | null,
  onProgress: OnProgress = noopProgress,
): Promise<void> {
  return ensureLeanLoaded(coreBundles, coreKey, onProgress).catch((e) => {
    console.warn('[leanWasm] prewarm failed:', e);
    disposeLeanWorker();
  });
}

export interface BrowserCompileOptions {
  libraryPaths?: string[];
  /** Stable project core, staged once at worker INIT (pre-warmable). */
  coreBundles?: Uint8Array[];
  /** Identity of the core (e.g. project id); a change forces a re-init. */
  coreKey?: string | null;
  /** Per-file delta bundles, staged per compile into /lean/lib/lean. */
  deltaBundles?: Uint8Array[];
  onProgress?: OnProgress;
}

/**
 * Compile Lean source in-browser. Each call:
 *   - awaits worker init (reuses a pre-warmed spare for the same core)
 *   - sends a compile message (with just the per-file delta)
 *   - awaits the matching `result` reply
 *   - disposes the worker and pre-warms a fresh spare for next time
 *
 * Hard timeout still enforced because a wedged worker would otherwise
 * leave the UI in a permanent "compiling" state.
 */
export async function compileInBrowser(
  source: string,
  opts: BrowserCompileOptions = {}
): Promise<CompileResult> {
  const onProgress = opts.onProgress ?? noopProgress;
  const coreBundles = opts.coreBundles ?? [];
  const coreKey = opts.coreKey ?? null;
  await ensureLeanLoaded(coreBundles, coreKey, onProgress);
  if (!state.worker) throw new Error('leanWasm: worker missing after init');
  if (state.initError) throw state.initError;

  const requestId = state.nextRequestId++;
  // Cold Mathlib elaborations load a large olean closure before running.
  // Keep the UI bound generous but finite. Matches the worker-side budget.
  const HARD_TIMEOUT_MS = 960_000;

  // After each compile, dispose the worker (PROXY_TO_PTHREAD +
  // noExitRuntime:false means the runtime tears down once main exits and a
  // 2nd callMain fails), then immediately pre-warm a fresh spare — JIT'd
  // wasm (cached) + the project core re-staged — so the *next* compile only
  // pays its delta + elaboration instead of the full cold start.
  const finalize = () => {
    disposeLeanWorker();
    // Re-warm a spare even with an empty core: the next compile still skips
    // stdlib staging + wasm JIT readiness. dispose terminated the old worker
    // first, so we don't hold two full MEMFS images at once.
    void prewarmLeanWorker(coreBundles, coreKey);
  };

  return new Promise<CompileResult>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      state.pending.delete(requestId);
      finalize();
      reject(new Error('compileInBrowser timeout (' + HARD_TIMEOUT_MS / 1000 + 's)'));
    }, HARD_TIMEOUT_MS);

    state.pending.set(requestId, {
      resolve: (r) => { clearTimeout(timeoutHandle); finalize(); resolve(r); },
      reject: (e) => { clearTimeout(timeoutHandle); finalize(); reject(e); },
      onProgress,
    });

    state.worker!.postMessage({
      type: 'compile',
      requestId,
      source,
      libraryPaths: opts.libraryPaths ?? [],
      projectOleansBundles: opts.deltaBundles ?? [],
    });
  });
}

/** Tear down the worker. Used by tests + cancel paths. */
export function disposeLeanWorker(): void {
  state.worker?.terminate();
  state.worker = null;
  state.ready = null;
  state.initError = null;
  for (const inflight of state.pending.values()) {
    inflight.reject(new Error('worker disposed'));
  }
  state.pending.clear();
}

export function parseJsonDiagnostics(stdout: string): { diagnostics: LeanDiagnostic[]; residualStdout: string } {
  const diagnostics: LeanDiagnostic[] = [];
  const residual: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.severity && obj.pos && typeof obj.pos.line === 'number') {
          diagnostics.push(obj as LeanDiagnostic);
          continue;
        }
      } catch (_) { /* fall through */ }
    }
    residual.push(line);
  }
  return { diagnostics, residualStdout: residual.join('\n') };
}
