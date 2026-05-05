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

interface WorkerState {
  worker: Worker | null;
  ready: Promise<void> | null;
  // Map requestId → pending compile.
  pending: Map<number, InflightCompile>;
  // Used to surface init failures to any compile already queued.
  initError: Error | null;
  nextRequestId: number;
}

const state: WorkerState = {
  worker: null,
  ready: null,
  pending: new Map(),
  initError: null,
  nextRequestId: 1,
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
 * Spawn the worker and have it instantiate Lean + stage Init oleans.
 * Idempotent: subsequent calls return the same promise.
 */
export function ensureLeanLoaded(onProgress: OnProgress = noopProgress): Promise<void> {
  if (state.ready) return state.ready;
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
    state.worker.postMessage({
      type: 'init',
      leanJsUrl: LEAN_JS_URL,
      manifestUrl: MANIFEST_URL,
    });
  });
  return state.ready;
}

export interface BrowserCompileOptions {
  libraryPaths?: string[];
  onProgress?: OnProgress;
}

/**
 * Compile Lean source in-browser. Each call:
 *   - awaits worker init (lazy on first call)
 *   - sends a compile message to the worker
 *   - awaits the matching `result` reply
 *
 * Hard timeout still enforced because a wedged worker would otherwise
 * leave the UI in a permanent "compiling" state.
 */
export async function compileInBrowser(
  source: string,
  opts: BrowserCompileOptions = {}
): Promise<CompileResult> {
  const onProgress = opts.onProgress ?? noopProgress;
  await ensureLeanLoaded(onProgress);
  if (!state.worker) throw new Error('leanWasm: worker missing after init');
  if (state.initError) throw state.initError;

  const requestId = state.nextRequestId++;
  const HARD_TIMEOUT_MS = 180_000;

  return new Promise<CompileResult>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error('compileInBrowser timeout (' + HARD_TIMEOUT_MS / 1000 + 's)'));
    }, HARD_TIMEOUT_MS);

    state.pending.set(requestId, {
      resolve: (r) => { clearTimeout(timeoutHandle); resolve(r); },
      reject: (e) => { clearTimeout(timeoutHandle); reject(e); },
      onProgress,
    });

    state.worker!.postMessage({
      type: 'compile',
      requestId,
      source,
      libraryPaths: opts.libraryPaths ?? [],
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
