import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// localStorage keys. The old proofs key stays around (we don't delete it)
// so a downgrade still finds the user's data — but new state is read from
// and written to the projects key.
const PROJECTS_STORAGE_KEY = 'lean-wasm-ide.projects.v1';
const LEGACY_PROOFS_KEY = 'lean-wasm-ide.proofs.v1';

export interface ProjectFile {
  /** Path relative to the project root. For scratch projects: "main.lean". */
  path: string;
  content: string;
}

export interface Project {
  id: string;
  name: string;
  /** Filesystem root if imported from disk; null for in-IDE-only projects. */
  root: string | null;
  /** Files keyed by their relative path. */
  files: Record<string, ProjectFile>;
  /** Path of the currently-open file within this project. */
  currentPath: string | null;
  /** Library paths shared across all files in the project (BYOML). */
  libraryPaths: string[];
  /** Project-level mermaid design diagram. */
  mermaidSource: string;
  /** Packed binary bundle of project oleans (.lake/build/lib/lean/**)
   * fetched at import time. Same wire format as /vendor/oleans.bundle:
   *   u32 count; per entry: u16 pathLen, path, u32 dataLen, data.
   * Held outside Redux because Uint8Array isn't serializable;
   * see __projectOleansByProject in this slice. */
}

// Side-table holding non-serializable bundle bytes. Keyed by project id.
// Lives outside the Redux state so RTK's serialization warnings don't
// fire on each render; the IDE never persists or replays this — it's
// re-fetched whenever a project is re-imported.
const __projectOleansByProject = new Map<string, Uint8Array>();
export function setProjectOleansBundle(projectId: string, bytes: Uint8Array | null) {
  if (bytes) __projectOleansByProject.set(projectId, bytes);
  else __projectOleansByProject.delete(projectId);
}
export function getProjectOleansBundle(projectId: string): Uint8Array | null {
  return __projectOleansByProject.get(projectId) ?? null;
}

export interface ProjectsState {
  entities: Record<string, Project>;
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

function newId(): string {
  return 'p-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

/** Build a one-file scratch project. */
function makeScratchProject(name = 'scratch'): Project {
  const path = 'main.lean';
  return {
    id: newId(),
    name,
    root: null,
    files: { [path]: { path, content: DEFAULT_LEAN } },
    currentPath: path,
    libraryPaths: [],
    mermaidSource: DEFAULT_MERMAID,
  };
}

/** Load persisted state. Tries v1 projects first, then migrates v1 proofs. */
function loadInitialState(): ProjectsState {
  if (typeof localStorage === 'undefined') {
    const p = makeScratchProject();
    return { entities: { [p.id]: p }, ids: [p.id], currentId: p.id };
  }

  // 1. Existing projects v1.
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ids && parsed.ids.length > 0) {
        return parsed as ProjectsState;
      }
    }
  } catch { /* fall through to legacy migration */ }

  // 2. Migrate from legacy proofs v1.
  try {
    const raw = localStorage.getItem(LEGACY_PROOFS_KEY);
    if (raw) {
      const legacy = JSON.parse(raw);
      if (legacy && legacy.ids && legacy.ids.length > 0) {
        const entities: Record<string, Project> = {};
        for (const id of legacy.ids) {
          const proof = legacy.entities[id];
          if (!proof) continue;
          const filePath = 'main.lean';
          entities[id] = {
            id,
            name: proof.name ?? 'proof',
            root: null,
            files: { [filePath]: { path: filePath, content: proof.leanSource ?? DEFAULT_LEAN } },
            currentPath: filePath,
            libraryPaths: Array.isArray(proof.libraryPaths) ? proof.libraryPaths : [],
            mermaidSource: proof.mermaidSource ?? DEFAULT_MERMAID,
          };
        }
        return { entities, ids: legacy.ids, currentId: legacy.currentId ?? legacy.ids[0] };
      }
    }
  } catch { /* fall through */ }

  // 3. Fresh default.
  const p = makeScratchProject();
  return { entities: { [p.id]: p }, ids: [p.id], currentId: p.id };
}

const slice = createSlice({
  name: 'projects',
  initialState: loadInitialState,
  reducers: {
    addScratchProject: (state, { payload }: PayloadAction<{ name?: string } | undefined>) => {
      const p = makeScratchProject(payload?.name ?? 'project ' + (state.ids.length + 1));
      state.entities[p.id] = p;
      state.ids.push(p.id);
      state.currentId = p.id;
    },
    importProject: (state, { payload }: PayloadAction<{ name: string; root: string; files: { path: string; content: string }[] }>) => {
      const id = newId();
      const filesMap: Record<string, ProjectFile> = {};
      for (const f of payload.files) {
        filesMap[f.path] = { path: f.path, content: f.content };
      }
      // Pick a sensible currentPath — first file alphabetically is fine.
      const sortedPaths = Object.keys(filesMap).sort();
      const project: Project = {
        id,
        name: payload.name,
        root: payload.root,
        files: filesMap,
        currentPath: sortedPaths[0] ?? null,
        libraryPaths: [],
        mermaidSource: DEFAULT_MERMAID,
      };
      state.entities[id] = project;
      state.ids.push(id);
      state.currentId = id;
    },
    selectProject: (state, { payload }: PayloadAction<string>) => {
      if (state.entities[payload]) state.currentId = payload;
    },
    deleteProject: (state, { payload }: PayloadAction<string>) => {
      if (!state.entities[payload]) return;
      delete state.entities[payload];
      state.ids = state.ids.filter((id) => id !== payload);
      if (state.currentId === payload) state.currentId = state.ids[0] ?? null;
      if (state.ids.length === 0) {
        const p = makeScratchProject();
        state.entities[p.id] = p;
        state.ids.push(p.id);
        state.currentId = p.id;
      }
    },
    renameProject: (state, { payload }: PayloadAction<{ id: string; name: string }>) => {
      const p = state.entities[payload.id];
      if (p) p.name = payload.name || p.name;
    },
    selectFile: (state, { payload }: PayloadAction<{ projectId: string; path: string }>) => {
      const p = state.entities[payload.projectId];
      if (p && p.files[payload.path]) p.currentPath = payload.path;
    },
    updateFileContent: (state, { payload }: PayloadAction<{ projectId: string; path: string; content: string }>) => {
      const p = state.entities[payload.projectId];
      if (!p) return;
      const f = p.files[payload.path];
      if (f) f.content = payload.content;
    },
    addFile: (state, { payload }: PayloadAction<{ projectId: string; path: string; content?: string }>) => {
      const p = state.entities[payload.projectId];
      if (!p || p.files[payload.path]) return;
      p.files[payload.path] = { path: payload.path, content: payload.content ?? '' };
      p.currentPath = payload.path;
    },
    deleteFile: (state, { payload }: PayloadAction<{ projectId: string; path: string }>) => {
      const p = state.entities[payload.projectId];
      if (!p) return;
      delete p.files[payload.path];
      if (p.currentPath === payload.path) {
        const remaining = Object.keys(p.files).sort();
        p.currentPath = remaining[0] ?? null;
      }
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
  addScratchProject, importProject, selectProject, deleteProject, renameProject,
  selectFile, updateFileContent, addFile, deleteFile, updateMermaid,
  addLibraryPath, updateLibraryPath, removeLibraryPath,
} = slice.actions;
export const projectsReducer = slice.reducer;
export { PROJECTS_STORAGE_KEY };
