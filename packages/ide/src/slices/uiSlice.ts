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
  // Default to in-page WASM. Verified end-to-end (returns correct
  // diagnostics for `def x : Nat := 42; #eval x`). Cold start is ~67s
  // because we stage ~8000 olean files (Init + Std + Lean). Server
  // mode is still available via the toggle for users who want it.
  compileMode: 'browser',
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
