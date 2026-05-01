import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type View = 'editor' | 'architecture';
export type RightPane = 'output' | 'design';
export type CompileMode = 'server' | 'browser';

interface UiState {
  view: View;
  rightPane: RightPane;
  compileMode: CompileMode;
}

const initialState: UiState = {
  view: 'editor',
  rightPane: 'output',
  // Default to in-page WASM so the IDE works as a static-files-only
  // app (no server compile endpoint required). The /api/compile path
  // remains available as a fallback users can pick from the toggle.
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
