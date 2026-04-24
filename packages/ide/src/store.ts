import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import { proofsReducer } from './slices/proofsSlice';
import { compileReducer } from './slices/compileSlice';
import { uiReducer } from './slices/uiSlice';

export const store = configureStore({
  reducer: {
    proofs: proofsReducer,
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

// Persist proofs slice to localStorage on every change. Loading from storage
// happens inside proofsSlice itself (to avoid a circular import).
const STORAGE_KEY = 'lean-wasm-ide.proofs.v1';
store.subscribe(() => {
  try {
    const { entities, ids, currentId } = store.getState().proofs;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entities, ids, currentId }));
  } catch {}
});
