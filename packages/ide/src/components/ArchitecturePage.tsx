import { Mermaid } from './Mermaid';

const SYSTEM_DIAGRAM = `
flowchart LR
  subgraph Browser["Browser tab (Chrome)"]
    React["React + Redux app<br/>packages/ide"]
    Editor["CodeMirror 6 editor<br/>+ Lezer Lean grammar"]
    MermaidLib["Mermaid renderer"]
    Local["localStorage<br/>(proofs persisted)"]
    React --- Editor
    React --- MermaidLib
    React --- Local
  end

  subgraph Server["Node server :8787<br/>packages/tests/server.js"]
    Static["Static files<br/>COOP/COEP headers"]
    API["POST /api/compile"]
    Manifest["GET /vendor/manifest.json"]
  end

  subgraph Compile["Lean WASM (per request, spawned)"]
    Harness["preflight/trace_fs.js<br/>Node harness"]
    LeanWasm["lean.wasm<br/>v4.15.0 linux_wasm32"]
    MEMFS["MEMFS + NODEFS<br/>/Users mounted"]
    Oleans["~510 MB oleans<br/>on local disk"]
    Harness --> LeanWasm
    LeanWasm --> MEMFS
    MEMFS --> Oleans
  end

  React -- "POST source as JSON" --> API
  API -- "spawn node harness" --> Harness
  Harness -- "stdout/stderr" --> API
  API -- "JSON: {stdout, stderr, exitCode, ms}" --> React
  Browser -- "fetch assets" --> Static
`;

const COMPILE_FLOW = `
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser (React)
  participant S as Server
  participant H as Harness (Node)
  participant W as Lean WASM
  U->>B: edit Lean in CodeMirror
  U->>B: ⌘↵ Compile
  B->>S: POST /api/compile { source }
  S->>S: write source to .compile-scratch/<id>/Input.lean
  S->>H: spawn node trace_fs.js Input.lean
  H->>W: load lean.wasm, mount /Users, set env
  W->>W: parse + elaborate (60-100 s cold)
  W-->>H: stdout / stderr
  H-->>S: close (exit code)
  S->>S: rm -rf .compile-scratch/<id>
  S-->>B: { stdout, stderr, exitCode, ms }
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
  end

  subgraph Store["Redux store"]
    PS["proofs slice<br/>entities, ids, currentId"]
    CS["compile slice<br/>status, result, elapsed"]
    US["ui slice<br/>view, rightPane"]
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
  CS -->|useAppSelector| Right
  CS -->|useAppSelector| Diag
  US -->|useAppSelector| Right

  PS -->|on change| LS
  CS -->|pending or fulfilled| API
`;

const IN_BROWSER_WASM_STATUS = `
flowchart TB
  A[v4.15 linux_wasm32 lean.wasm] --> B{"Browser boot + shims<br/>(process, NODEFS→MEMFS, __filename)"}
  B -->|metadata commands| C["✓ --version, --help, --print-libdir<br/>✓ olean seeding into MEMFS"]
  B -->|process a .lean file| D["✗ tab hangs or crashes"]
  B -->|--server LSP mode| E["✗ hangs on first real message"]
  D --> F["Inside WASM: likely pthread deadlock<br/>or C++ exception that can't unwind"]
  E --> F
  F --> G["Not shimmable from JS<br/>→ upstream work: new C++ browser entrypoint<br/>or Emscripten pthread-pool build"]
`;

export function ArchitecturePage() {
  return (
    <div className="arch-page">
      <h1>Architecture</h1>
      <p>
        The IDE is a React/Redux app (Vite dev server at <code>:5173</code>) that POSTs Lean source
        to a small Node server (<code>:8787</code>), which spawns the Lean WASM binary inside Node to do
        the actual compile. No native Lean install is required — the WASM tarball <code>vendor/lean-linux_wasm32</code> is
        the only Lean that exists on the server.
      </p>

      <h2>System</h2>
      <div className="diagram"><Mermaid source={SYSTEM_DIAGRAM} idPrefix="arch-system" /></div>

      <h2>Compile request flow</h2>
      <div className="diagram"><Mermaid source={COMPILE_FLOW} idPrefix="arch-flow" /></div>

      <h2>React / Redux wiring</h2>
      <p>
        Three slices hold all state; each component reads via <code>useAppSelector</code> and dispatches actions.
        The <code>compile</code> slice uses a Redux Toolkit async thunk for <code>/api/compile</code> — it emits
        pending/fulfilled/rejected actions so the Output pane can show a live elapsed-time counter while in-flight.
        A <code>store.subscribe</code> writes the proofs slice to <code>localStorage</code> on every change so
        proofs, library paths, and mermaid sources survive reloads.
      </p>
      <div className="diagram"><Mermaid source={REDUX_FLOW} idPrefix="arch-redux" /></div>

      <h2>In-browser WASM status</h2>
      <p>
        Lean WASM <em>does</em> load in the page (the <code>/</code> harness exercises it). Metadata commands
        run. But anything that processes a <code>.lean</code> file — batch compile or <code>lean --server</code> — hangs
        or crashes the tab. This is an architectural ceiling of the v4.15.0 CLI WASM, not a
        shimming problem. Fixing it needs upstream work; meanwhile we server-compile.
      </p>
      <div className="diagram"><Mermaid source={IN_BROWSER_WASM_STATUS} idPrefix="arch-status" /></div>

      <h2>Future directions</h2>
      <ul>
        <li><strong>Persistent warm Node worker</strong> — drop the ~70&nbsp;s cold-start by keeping one Lean instance alive across compiles.</li>
        <li><strong>BYOML in the UI</strong> — expose the existing <code>LEAN_EXTRA_PATH</code> / <code>LEAN_RESOLVER_JS</code> knobs so users can compile against their own Mathlib/project.</li>
        <li><strong>Proof goals at cursor</strong> — parse elaborator output or drive a keepalive-stdin <code>--server</code> session to show interactive goal state.</li>
        <li><strong>True in-browser WASM</strong> — write a browser C++ entry point against current Lean 4 APIs (<code>lean_js.cpp</code> in upstream is dead Lean 3 code), or build a PTHREAD_POOL_SIZE-configured Emscripten variant.</li>
      </ul>
    </div>
  );
}
