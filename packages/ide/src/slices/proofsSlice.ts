import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// Load persisted proofs state. Inlined here (not imported from store.ts) to
// avoid a circular import that caused the lazy initial-state function to see
// a non-initialized loader and silently return null.
const STORAGE_KEY = 'lean-wasm-ide.proofs.v1';
function loadPersistedProofs(): any {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface Proof {
  id: string;
  name: string;
  leanSource: string;
  mermaidSource: string;
  /** Extra library roots to prepend to LEAN_PATH for this proof (BYOML). */
  libraryPaths: string[];
}

export interface ProofsState {
  entities: Record<string, Proof>;
  ids: string[];
  currentId: string | null;
}

const DEFAULT_LEAN = `import Std

def greet (name : String) : String := "hello " ++ name

#eval greet "world"
`;

const DEFAULT_MERMAID = `%% Sketch the structure of your proof here.
%% This diagram is free-form; render it while you think.
graph TD
  hyp[hypothesis] --> lem1[lemma 1]
  hyp --> lem2[lemma 2]
  lem1 --> thm[main theorem]
  lem2 --> thm
`;

function makeDefaultProof(): Proof {
  return {
    id: 'p-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
    name: 'scratch',
    leanSource: DEFAULT_LEAN,
    mermaidSource: DEFAULT_MERMAID,
    libraryPaths: [],
  };
}

function normalizeProof(p: any): Proof {
  // Backfill libraryPaths on proofs loaded from older localStorage shapes.
  return { libraryPaths: [], ...(p ?? {}) } as Proof;
}

function makeInitialState(): ProofsState {
  const persisted = loadPersistedProofs();
  if (persisted && persisted.ids && persisted.ids.length > 0) {
    const entities: Record<string, Proof> = {};
    for (const id of persisted.ids) entities[id] = normalizeProof(persisted.entities[id]);
    return { entities, ids: persisted.ids, currentId: persisted.currentId };
  }
  const p = makeDefaultProof();
  return { entities: { [p.id]: p }, ids: [p.id], currentId: p.id };
}

const slice = createSlice({
  name: 'proofs',
  initialState: makeInitialState,
  reducers: {
    addProof: (state, { payload }: PayloadAction<{ name?: string } | undefined>) => {
      const p: Proof = {
        ...makeDefaultProof(),
        name: payload?.name ?? 'proof ' + (state.ids.length + 1),
      };
      state.entities[p.id] = p;
      state.ids.push(p.id);
      state.currentId = p.id;
    },
    selectProof: (state, { payload }: PayloadAction<string>) => {
      if (state.entities[payload]) state.currentId = payload;
    },
    deleteProof: (state, { payload }: PayloadAction<string>) => {
      if (!state.entities[payload]) return;
      delete state.entities[payload];
      state.ids = state.ids.filter((id) => id !== payload);
      if (state.currentId === payload) {
        state.currentId = state.ids[0] ?? null;
      }
      if (state.ids.length === 0) {
        const p = makeDefaultProof();
        state.entities[p.id] = p;
        state.ids.push(p.id);
        state.currentId = p.id;
      }
    },
    renameProof: (state, { payload }: PayloadAction<{ id: string; name: string }>) => {
      const p = state.entities[payload.id];
      if (p) p.name = payload.name || p.name;
    },
    updateLean: (state, { payload }: PayloadAction<{ id: string; source: string }>) => {
      const p = state.entities[payload.id];
      if (p) p.leanSource = payload.source;
    },
    updateMermaid: (state, { payload }: PayloadAction<{ id: string; source: string }>) => {
      const p = state.entities[payload.id];
      if (p) p.mermaidSource = payload.source;
    },
    addLibraryPath: (state, { payload }: PayloadAction<{ id: string; path: string }>) => {
      const p = state.entities[payload.id];
      const v = payload.path.trim();
      if (p && v && !p.libraryPaths.includes(v)) p.libraryPaths.push(v);
    },
    updateLibraryPath: (state, { payload }: PayloadAction<{ id: string; index: number; path: string }>) => {
      const p = state.entities[payload.id];
      if (p && payload.index >= 0 && payload.index < p.libraryPaths.length) {
        p.libraryPaths[payload.index] = payload.path;
      }
    },
    removeLibraryPath: (state, { payload }: PayloadAction<{ id: string; index: number }>) => {
      const p = state.entities[payload.id];
      if (p) p.libraryPaths = p.libraryPaths.filter((_, i) => i !== payload.index);
    },
  },
});

export const {
  addProof, selectProof, deleteProof, renameProof, updateLean, updateMermaid,
  addLibraryPath, updateLibraryPath, removeLibraryPath,
} = slice.actions;
export const proofsReducer = slice.reducer;
