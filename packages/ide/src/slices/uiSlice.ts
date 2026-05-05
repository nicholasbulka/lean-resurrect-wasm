import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type View = 'editor' | 'architecture';
export type RightPane = 'output' | 'design' | 'graph';
export type CompileMode = 'server' | 'browser';

interface UiState {
  view: View;
  rightPane: RightPane;
  compileMode: CompileMode;
}

const initialState: UiState = {
  view: 'editor',
  rightPane: 'output',
  // Default to server-side compile: the v4.27 WASM build in-browser
  // hangs in pthread main on any callMain (even --version), so
  // browser-mode compile times out without producing output. Until
  // that's resolved, server is the only path that actually elaborates.
  // Users can still flip the toggle to browser to experiment.
  compileMode: 'server',
};

const slice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setView: (state, { payload }: PayloadAction<View>) => {
      state.view = payload;
    },
    setRightPane: (state, { payload }: PayloadAction<RightPane>) => {
      state.rightPane = payload;
    },
    setCompileMode: (state, { payload }: PayloadAction<CompileMode>) => {
      state.compileMode = payload;
    },
  },
});

export const { setView, setRightPane, setCompileMode } = slice.actions;
export const uiReducer = slice.reducer;
