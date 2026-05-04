import { Mermaid } from './Mermaid';

const SYSTEM_DIAGRAM = `
flowchart LR
  subgraph Browser["Browser tab (Chrome)"]
    React["React + Redux app<br/>packages/ide"]
    Editor["CodeMirror 6 editor<br/>+ Lezer Lean grammar"]
    Lint["@codemirror/lint<br/>(diagnostic squiggles)"]
    GraphView["Sigma + graphology<br/>(Lean import graph)"]
    MermaidLib["Mermaid renderer<br/>(authored diagrams)"]
    Local["localStorage<br/>(proofs persisted)"]
    Worker["Web Worker<br/>v4.27 MT=ON Lean WASM"]
    React --- Editor
    Editor --- Lint
    React --- GraphView
    React --- MermaidLib
    React --- Local
    React --- Worker
  end

  subgraph Server["Node server :8787<br/>packages/tests/server.js"]
    Static["Static files<br/>COOP/COEP headers"]
    API["POST /api/compile"]
    Manifest["GET /vendor/manifest.json"]
  end

  subgraph Compile["Lean WASM (Node-spawned, server mode)"]
    Harness["preflight/trace_fs.js<br/>Node harness"]
    LeanWasm["lean.wasm<br/>v4.27 linux_wasm32 (MT=ON)"]
    MEMFS["MEMFS + NODEFS<br/>/Users mounted"]
    Oleans["~510 MB oleans<br/>on local disk"]
    Harness --> LeanWasm
    LeanWasm --> MEMFS
    MEMFS --> Oleans
  end

  React -- "POST source as JSON" --> API
  API -- "spawn node harness" --> Harness
  Harness -- "stdout/stderr (--json)" --> API
  API -- "JSON: {stdout, stderr, exitCode, ms}" --> React
  Browser -- "fetch assets" --> Static
`;

const COMPILE_FLOW = `
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser (React + CM6)
  participant S as Server
  participant H as Harness (Node)
  participant W as Lean WASM
  U->>B: edit Lean in CodeMirror
  B->>B: Lezer grammar parses → live highlight + fold
  U->>B: ⌘↵ Compile
  B->>S: POST /api/compile { source }
  S->>S: write source to .compile-scratch/<id>/Input.lean
  S->>H: spawn node trace_fs.js Input.lean
  H->>W: load lean.wasm, mount /Users, set env
  W->>W: parse + elaborate (--json output)
  W-->>H: stdout / stderr
  H-->>S: close (exit code)
  S->>S: rm -rf .compile-scratch/<id>
  S-->>B: { stdout, stderr, exitCode, ms }
  B->>B: setLeanDiagnostics → CM6 lint squiggles
  B->>U: render in Output pane
`;

const REDUX_FLOW = `
flowchart LR
  subgraph Components["React components"]
    Menu[ProofMenu]
    Editor[EditorPane]
    Right[RightPane]
    Diag[Diagnostics]
    Lib[LibraryPaths]
    Graph[GraphView]
  end

  subgraph Store["Redux store"]
    PS["proofs slice<br/>entities, ids, currentId"]
    CS["compile slice<br/>status, result, elapsed"]
    US["ui slice<br/>view, rightPane: output | design | graph"]
  end

  subgraph Side["Side effects"]
    LS["localStorage<br/>store.subscribe"]
    API["/api/compile<br/>async thunk"]
  end

  Menu -->|"dispatch addProof, selectProof, rename"| PS
  Editor -->|"dispatch updateLean"| PS
  Editor -->|"dispatch compileSource"| CS
  Lib -->|"dispatch addLibraryPath"| PS
  Right -->|"dispatch setRightPane"| US
  Menu -->|"dispatch setView"| US

  PS -->|useAppSelector| Menu
  PS -->|useAppSelector| Editor
  PS -->|useAppSelector| Right
  PS -->|useAppSelector| Lib
  PS -->|useAppSelector| Graph
  CS -->|useAppSelector| Right
  CS -->|useAppSelector| Diag
  US -->|useAppSelector| Right

  PS -->|on change| LS
  CS -->|pending or fulfilled| API
`;

const GRAMMAR_PIPELINE = `
flowchart LR
  subgraph LezerStack["Lezer pipeline (in browser)"]
    Grammar["lean.grammar<br/>compiled by @lezer/generator"]
    Parser["LRParser instance"]
    LangSupport["LanguageSupport<br/>+ styleTags + foldNodeProp"]
    Tree["Lezer SyntaxTree"]
  end

  subgraph CMExt["CM6 extensions"]
    Highlight["syntaxHighlighting<br/>(CSS classes per token)"]
    Fold["foldGutter<br/>(by Declaration / Block)"]
    Lint["lint state field<br/>(setLeanDiagnostics)"]
  end

  subgraph Harness["tools/grammar-accuracy/"]
    DumpLean["dump-tokens.lean<br/>(authoritative ground truth)"]
    Diff["diff.mjs<br/>(per-byte agreement)"]
    Corpus["LiCriterion corpus<br/>~5.7MB / 166 files"]
  end

  Grammar --> Parser
  Parser --> Tree
  Tree --> LangSupport
  LangSupport --> Highlight
  LangSupport --> Fold
  LangSupport --> Lint

  DumpLean -->|JSONL tokens| Diff
  Parser -->|JSONL tokens| Diff
  Corpus --> DumpLean
  Corpus --> Parser
  Diff --> Score["99.99% per-byte agreement"]
`;

const IN_BROWSER_WASM_STATUS = `
flowchart TB
  A[v4.27 linux_wasm32 lean.wasm<br/>MT=ON + PROXY_TO_PTHREAD] --> B{"Browser boot + Web Worker"}
  B -->|"server mode (POST /api/compile)"| OK1["✓ Node-spawned WASM works<br/>(returns 42 on #eval x)"]
  B -->|"in-browser, command-line metadata"| OK2["✓ --version, --help, etc."]
  B -->|"in-browser, real .lean file"| Partial["⚠ pthread runs to completion<br/>(callMain returns 0 in ~3ms)<br/>but stdout never reaches outer worker"]
  Partial --> Cause["Pthread output relay:<br/>emcc PThread machinery installs its<br/>own postMessage handlers; our<br/>__leanStdout envelopes don't escape"]
  Cause --> Next["Active investigation: instrument<br/>pthread Module.print, route via<br/>SharedArrayBuffer counter"]
`;

export function ArchitecturePage() {
  return (
    <div className="arch-page">
      <h1>Architecture</h1>
      <p>
        The IDE is a React + Redux + CodeMirror 6 app (Vite dev server at <code>:5173</code>) that POSTs Lean source
        to a small Node server (<code>:8787</code>), which spawns the Lean WASM binary inside Node to do
        the actual compile. No native Lean install is required — the WASM tarball <code>vendor/lean-linux_wasm32</code> is
        the only Lean that exists on the server. Editor highlighting, folding, and lint markers are
        driven by a custom Lezer grammar for Lean 4.27 (~99.99% per-byte agreement with Lean's own parser
        on the LiCriterion corpus).
      </p>

      <h2>System</h2>
      <div className="diagram"><Mermaid source={SYSTEM_DIAGRAM} idPrefix="arch-system" /></div>

      <h2>Compile request flow</h2>
      <div className="diagram"><Mermaid source={COMPILE_FLOW} idPrefix="arch-flow" /></div>

      <h2>Lezer grammar pipeline + accuracy harness</h2>
      <p>
        The Lean grammar (<code>packages/ide/src/lib/cm/lean.grammar</code>) is compiled at build time by{' '}
        <code>@lezer/generator</code>. The resulting parser is the source of truth for syntax highlighting,
        folding, and structural navigation in the editor. A nightly accuracy harness diffs our token output
        against Lean's own <code>Lean.Parser</code> on the LiCriterion corpus to catch drift.
      </p>
      <div className="diagram"><Mermaid source={GRAMMAR_PIPELINE} idPrefix="arch-grammar" /></div>

      <h2>React / Redux wiring</h2>
      <p>
        Three slices hold all state; each component reads via <code>useAppSelector</code> and dispatches actions.
        The <code>compile</code> slice uses a Redux Toolkit async thunk for <code>/api/compile</code> — it emits
        pending/fulfilled/rejected actions so the Output pane can show a live elapsed-time counter while in-flight.
        A <code>store.subscribe</code> writes the proofs slice to <code>localStorage</code> on every change so
        proofs, library paths, and mermaid sources survive reloads. The right pane has three tabs:{' '}
        <strong>Output</strong> (compile diagnostics), <strong>Design</strong> (per-proof mermaid sketch),{' '}
        <strong>Graph</strong> (Sigma-rendered import graph; in progress).
      </p>
      <div className="diagram"><Mermaid source={REDUX_FLOW} idPrefix="arch-redux" /></div>

      <h2>In-browser WASM status</h2>
      <p>
        The v4.27 MT=ON build ships in <code>vendor/lean-linux_wasm32/</code> and works server-side
        (Node-spawned for <code>/api/compile</code>). The in-browser path runs the same binary in a Web
        Worker with PROXY_TO_PTHREAD; metadata commands work; on a real <code>.lean</code> file the pthread
        runs to completion (callMain returns) but its stdout doesn't relay through to the outer worker —
        so we see exit 0 with no diagnostics. The remaining work is wiring pthread output capture; until
        then, server mode is the production compile path.
      </p>
      <div className="diagram"><Mermaid source={IN_BROWSER_WASM_STATUS} idPrefix="arch-status" /></div>

      <h2>Future directions</h2>
      <ul>
        <li>
          <strong>In-browser WASM output relay</strong> — instrument the pthread's <code>Module.print</code>{' '}
          via SharedArrayBuffer counter so we can confirm whether output is being produced and lost, vs.
          never produced. Last remaining block on the in-browser compile path.
        </li>
        <li>
          <strong>On-demand Lean LSP</strong> — wire <code>lean --server</code> as a request/response oracle
          (not a streaming companion). Hover, goto-def, completion, and goal state fire on explicit user
          action; nothing background-elaborates while you type.
        </li>
        <li>
          <strong>Neo4j-backed proof graph</strong> — store theorems, dependencies, and tactic uses in Neo4j;
          render via Sigma + graphology. The Graph tab is the seed (Lean import graph today, broader proof
          structure later).
        </li>
        <li>
          <strong>Persistent warm Lean worker</strong> — drop ~70&nbsp;s cold-start by keeping one Lean
          instance alive across compiles.
        </li>
      </ul>
    </div>
  );
}
