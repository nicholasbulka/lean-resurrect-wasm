import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import { projectsReducer, PROJECTS_STORAGE_KEY } from './slices/projectsSlice';
import { compileReducer } from './slices/compileSlice';
import { uiReducer } from './slices/uiSlice';

export const store = configureStore({
  reducer: {
    projects: projectsReducer,
    compile: compileReducer,
    ui: uiReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
export const useAppDispatch = () => useDispatch<AppDispatch>();

// Expose store for Playwright tests to inspect Redux state directly.
if (typeof window !== 'undefined') (window as any).__store = store;

// Persist projects slice to localStorage on every change. Migration from
// the legacy 'lean-wasm-ide.proofs.v1' key happens inside projectsSlice's
// initial-state loader.
store.subscribe(() => {
  try {
    const { entities, ids, currentId } = store.getState().projects;
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify({ entities, ids, currentId }));
  } catch {}
});
