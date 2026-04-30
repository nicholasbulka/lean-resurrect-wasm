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
