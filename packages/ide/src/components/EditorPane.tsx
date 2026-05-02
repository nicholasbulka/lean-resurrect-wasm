import { useRef, useState, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { useAppDispatch, useAppSelector } from '../store';
import { updateLean } from '../slices/proofsSlice';
import { compileSource, cancelCurrentCompile } from '../slices/compileSlice';
import { LibraryPaths } from './LibraryPaths';
import { registerLeanLanguage } from '../lib/leanLanguage';
import { createMonacoBridge, createCm6Bridge } from '../lib/editorBridge';
import { CodeMirror } from '../lib/cm/CodeMirror';
import { leanLanguage as cmLeanLanguage } from '../lib/cm/leanLanguage';
import { setLeanDiagnostics } from '../lib/cm/leanDiagnostics';
import type { LeanDiagnostic } from '../slices/compileSlice';

const BACKEND: 'monaco' | 'cm6' =
  (import.meta.env.VITE_EDITOR_BACKEND as 'monaco' | 'cm6' | undefined) ?? 'monaco';

export function EditorPane() {
  const dispatch = useAppDispatch();
  const currentId = useAppSelector((s) => s.proofs.currentId);
  const proof = useAppSelector((s) => (currentId ? s.proofs.entities[currentId] : null));
  const status = useAppSelector((s) => s.compile.status);
  const compileMode = useAppSelector((s) => s.ui.compileMode);
  const monacoEdRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoNsRef = useRef<Parameters<OnMount>[1] | null>(null);
  const cmViewRef = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);
  const diagnostics = useAppSelector((s) => s.compile.result?.diagnostics ?? []);

  // runCompile captures live `proof`/`status`/`compileMode`. The CM6 keymap
  // closure is created once at mount, so it must read through a ref to see
  // the latest function.
  const runCompileRef = useRef<() => void>(() => {});

  if (!proof) return <div className="pane"><div className="pane-body" /></div>;

  async function runCompile() {
    if (!proof || status === 'running') return;
    await dispatch(compileSource({
      source: proof.leanSource,
      libraryPaths: proof.libraryPaths,
      mode: compileMode,
    }));
  }
  runCompileRef.current = runCompile;

  function cancelCompile() {
    cancelCurrentCompile();
  }

  // Reflect diagnostics into the editor as inline markers. Branches per
  // backend; CM6 path lands in Phase 4 (currently a no-op until then —
  // setLeanDiagnostics works but the editor without lint extension simply
  // displays them once setDiagnostics enables the state field).
  useEffect(() => {
    if (BACKEND === 'monaco') {
      const ed = monacoEdRef.current;
      const monaco = monacoNsRef.current;
      if (!ed || !monaco) return;
      const model = ed.getModel();
      if (!model) return;
      const markers = diagnostics.map((d: LeanDiagnostic) => ({
        severity:
          d.severity === 'error' ? monaco.MarkerSeverity.Error :
          d.severity === 'warning' ? monaco.MarkerSeverity.Warning :
          monaco.MarkerSeverity.Info,
        startLineNumber: d.pos.line,
        startColumn: d.pos.column + 1,
        endLineNumber: d.endPos?.line ?? d.pos.line,
        endColumn: (d.endPos?.column ?? d.pos.column + 1) + 1,
        message: d.data,
        source: 'lean',
      }));
      monaco.editor.setModelMarkers(model, 'lean-compile', markers);
    } else {
      const view = cmViewRef.current;
      if (!view) return;
      setLeanDiagnostics(view, diagnostics);
    }
  }, [diagnostics]);

  // window.__ideEditor: bridge for Diagnostics' jumpTo and Playwright tests.
  // `ready` flips after the underlying editor mounts.
  (window as any).__ideEditor = BACKEND === 'monaco'
    ? createMonacoBridge(monacoEdRef, monacoNsRef, ready)
    : createCm6Bridge(cmViewRef, ready);

  const cmExtensions = [
    basicSetup,
    keymap.of([
      { key: 'Mod-Enter', run: () => { runCompileRef.current(); return true; } },
    ]),
    cmLeanLanguage(),
  ];

  return (
    <div className="pane">
      <div className="pane-header">
        <strong>Lean</strong>
        <span style={{ color: 'var(--text-muted)' }}>{proof.leanSource.length} chars</span>
        <span style={{ flex: 1 }} />
        {status === 'running' ? (
          <button
            onClick={cancelCompile}
            style={{
              padding: '2px 10px', border: '1px solid var(--err)', borderRadius: 3,
              background: 'var(--err)', color: 'white', cursor: 'pointer', font: 'inherit',
            }}
            title="abort the current compile"
          >
            cancel
          </button>
        ) : (
          <button
            onClick={runCompile}
            style={{
              padding: '2px 10px', border: '1px solid var(--accent)', borderRadius: 3,
              background: 'var(--accent)', color: 'white', cursor: 'pointer', font: 'inherit',
            }}
          >
            compile <kbd>⌘↵</kbd>
          </button>
        )}
      </div>
      <LibraryPaths />
      <div className="pane-body" style={{ padding: 0 }}>
        {/* key per proof id: re-mount the editor when switching proofs, so we
            can safely use uncontrolled mode (defaultValue / initialValue). A
            controlled prop would re-sync editor content on every render and
            clobber programmatic setValue calls. */}
        {BACKEND === 'monaco' ? (
          <Editor
            key={proof.id}
            height="100%"
            language="lean4"
            theme="vs"
            defaultValue={proof.leanSource}
            onChange={(v) => dispatch(updateLean({ id: proof.id, source: v ?? '' }))}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              wordWrap: 'on',
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
            onMount={(editor, monaco) => {
              monacoEdRef.current = editor;
              monacoNsRef.current = monaco;
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCompile);
              setReady(true);
            }}
            beforeMount={(monaco) => { registerLeanLanguage(monaco); }}
          />
        ) : (
          <CodeMirror
            key={proof.id}
            initialValue={proof.leanSource}
            onChange={(v) => dispatch(updateLean({ id: proof.id, source: v }))}
            extensions={cmExtensions}
            onView={(view) => {
              cmViewRef.current = view;
              setReady(true);
            }}
          />
        )}
      </div>
    </div>
  );
}
