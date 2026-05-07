import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';

export interface LeanDiagnostic {
  severity: 'error' | 'warning' | 'information' | 'trace' | 'info';
  pos: { line: number; column: number };
  endPos?: { line: number; column: number } | null;
  fileName: string;
  caption?: string;
  data: string;
}

export interface CompileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ms: number;
  diagnostics: LeanDiagnostic[];
}

export interface CompileRequest {
  source: string;
  libraryPaths?: string[];
  mode?: 'server' | 'browser';
  /** Optional packed olean bundles to stage into MEMFS for this compile.
   * Each bundle is independently parsed and unpacked under /work/lib/lean.
   * Multiple bundles let a project import across dep packages (e.g.
   * batteries + aesop + Mathlib all at once). */
  projectOleansBundles?: Uint8Array[];
}

/** Sub-state for long-running phases (mostly the browser path's bootstrap). */
export interface CompileProgress {
  phase: string;        // 'fetching-manifest' | 'fetching-oleans' | 'staging' | 'loading-wasm' | 'compiling'
  current?: number;
  total?: number;
  message?: string;
}

export interface CompileState {
  status: 'idle' | 'running' | 'ok' | 'error';
  result: CompileResult | null;
  startedAt: number | null;
  elapsedMs: number;
  error: string | null;
  progress: CompileProgress | null;
}

const initialState: CompileState = {
  status: 'idle',
  result: null,
  startedAt: null,
  elapsedMs: 0,
  error: null,
  progress: null,
};

// Tracks the current in-flight compile so Cancel can abort it. We store the
// controller outside Redux because AbortControllers aren't serializable and
// don't belong in state.
let currentAbort: AbortController | null = null;

export function cancelCurrentCompile() {
  currentAbort?.abort();
  currentAbort = null;
}

export const compileSource = createAsyncThunk(
  'compile/run',
  async (req: CompileRequest, { dispatch }): Promise<CompileResult> => {
    currentAbort?.abort();
    currentAbort = new AbortController();
    const signal = currentAbort.signal;

    if (req.mode === 'browser') {
      const { compileInBrowser } = await import('../lib/leanWasm');
      return await compileInBrowser(req.source, {
        libraryPaths: req.libraryPaths,
        projectOleansBundles: req.projectOleansBundles,
        onProgress: (p: CompileProgress) => dispatch(slice.actions.setProgress(p)),
      });
    }

    const r = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
    return (await r.json()) as CompileResult;
  }
);

const slice = createSlice({
  name: 'compile',
  initialState,
  reducers: {
    clearOutput: (state) => {
      state.result = null;
      state.status = 'idle';
      state.error = null;
    },
    tickElapsed: (state) => {
      if (state.startedAt) state.elapsedMs = Date.now() - state.startedAt;
    },
    setProgress: (state, { payload }: PayloadAction<CompileProgress | null>) => {
      state.progress = payload;
    },
  },
  extraReducers: (b) => {
    b.addCase(compileSource.pending, (state) => {
      state.status = 'running';
      state.result = null;
      state.error = null;
      state.startedAt = Date.now();
      state.elapsedMs = 0;
      state.progress = null;
    });
    b.addCase(compileSource.fulfilled, (state, action: PayloadAction<CompileResult>) => {
      state.status = action.payload.exitCode === 0 ? 'ok' : 'error';
      state.result = action.payload;
      state.elapsedMs = Date.now() - (state.startedAt ?? Date.now());
      state.progress = null;
    });
    b.addCase(compileSource.rejected, (state, action) => {
      // AbortError → show as idle, not error.
      if (action.error.name === 'AbortError') {
        state.status = 'idle';
        state.error = null;
      } else {
        state.status = 'error';
        state.error = action.error.message ?? 'compile failed';
      }
      state.elapsedMs = Date.now() - (state.startedAt ?? Date.now());
      state.progress = null;
    });
  },
});

export const { clearOutput, tickElapsed, setProgress } = slice.actions;
export const compileReducer = slice.reducer;
