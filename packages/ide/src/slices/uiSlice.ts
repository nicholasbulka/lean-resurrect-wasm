import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type View = 'editor' | 'architecture';
export type RightPane = 'output' | 'design';

interface UiState {
  view: View;
  rightPane: RightPane;
}

const initialState: UiState = {
  view: 'editor',
  rightPane: 'output',
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
  },
});

export const { setView, setRightPane } = slice.actions;
export const uiReducer = slice.reducer;
