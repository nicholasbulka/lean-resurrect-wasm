# IDE

React + Redux + Monaco + Mermaid + Vite frontend for the Lean WASM backend.

## Run

### Production-style (single server)

Build once, then the Node server at `:8787` serves both the IDE and the compile API:

```sh
cd packages/ide && npm install && npm run build
cd ../tests && node server.js
# open http://localhost:8787
```

### Dev (Vite + HMR)

If you're iterating on the IDE code and want HMR:

```sh
# terminal 1: compile backend
cd packages/tests && node server.js

# terminal 2: Vite dev server (proxies /api and /vendor to :8787)
cd packages/ide && npm run dev
# open http://localhost:5173
```

## What it does

- **Proof menu** (top): a tab per proof, + to add, − to delete, double-click to rename. State persists to `localStorage`.
- **Editor view** (default): Monaco on the left holds your Lean source; right pane toggles between Output and Design.
- **Design pane**: a Mermaid diagram authored per-proof. Edit mermaid source below, see live preview above — use it to sketch proof structure (hypotheses → lemmas → theorem, etc.). Persisted alongside the Lean source.
- **Architecture view**: static page with Mermaid diagrams of the system and compile flow.
- **⌘↵ / Ctrl↵** in the editor (or the Compile button) runs the current proof through `/api/compile`. Output or stderr shows in the Output pane.

## Tech

| | |
|---|---|
| Framework | React 18 + @reduxjs/toolkit |
| Bundler | Vite 6 |
| Editor | @monaco-editor/react (loads Monaco from CDN) |
| Diagrams | mermaid v11 |
| Types | TypeScript strict mode |

## Redux slices

- `proofs` — `{ entities, ids, currentId }`. Each Proof has `{ id, name, leanSource, mermaidSource }`.
- `compile` — async thunk status + result from `/api/compile`.
- `ui` — top-level view (`editor` / `architecture`) and right-pane tab (`output` / `design`).

## Tests

Playwright tests for the React IDE live at `packages/tests/tests/ide-react.spec.ts`. They spin up the Vite dev server (you start it manually; the tests expect `:5173`). Cover: menu, new/rename, architecture page, design mermaid, end-to-end compile.

```sh
cd packages/tests
npx playwright test --project=browser -g 'React IDE'
```
