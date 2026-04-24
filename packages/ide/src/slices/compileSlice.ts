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
}

export interface CompileState {
  status: 'idle' | 'running' | 'ok' | 'error';
  result: CompileResult | null;
  startedAt: number | null;
  elapsedMs: number;
  error: string | null;
}

const initialState: CompileState = {
  status: 'idle',
  result: null,
  startedAt: null,
  elapsedMs: 0,
  error: null,
};

export const compileSource = createAsyncThunk(
  'compile/run',
  async (req: CompileRequest): Promise<CompileResult> => {
    const r = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
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
  },
  extraReducers: (b) => {
    b.addCase(compileSource.pending, (state) => {
      state.status = 'running';
      state.result = null;
      state.error = null;
      state.startedAt = Date.now();
      state.elapsedMs = 0;
    });
    b.addCase(compileSource.fulfilled, (state, action: PayloadAction<CompileResult>) => {
      state.status = action.payload.exitCode === 0 ? 'ok' : 'error';
      state.result = action.payload;
      state.elapsedMs = Date.now() - (state.startedAt ?? Date.now());
    });
    b.addCase(compileSource.rejected, (state, action) => {
      state.status = 'error';
      state.error = action.error.message ?? 'compile failed';
      state.elapsedMs = Date.now() - (state.startedAt ?? Date.now());
    });
  },
});

export const { clearOutput, tickElapsed } = slice.actions;
export const compileReducer = slice.reducer;
