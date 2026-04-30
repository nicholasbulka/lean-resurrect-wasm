import { useRef, useState, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppDispatch, useAppSelector } from '../store';
import { updateLean } from '../slices/proofsSlice';
import { compileSource, cancelCurrentCompile } from '../slices/compileSlice';
import { LibraryPaths } from './LibraryPaths';
import { registerLeanLanguage } from '../lib/leanLanguage';
import type { LeanDiagnostic } from '../slices/compileSlice';

export function EditorPane() {
  const dispatch = useAppDispatch();
  const currentId = useAppSelector((s) => s.proofs.currentId);
  const proof = useAppSelector((s) => (currentId ? s.proofs.entities[currentId] : null));
  const status = useAppSelector((s) => s.compile.status);
  const compileMode = useAppSelector((s) => s.ui.compileMode);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const [ready, setReady] = useState(false);
  const diagnostics = useAppSelector((s) => s.compile.result?.diagnostics ?? []);

  if (!proof) return <div className="pane"><div className="pane-body" /></div>;

  async function runCompile() {
    if (!proof || status === 'running') return;
    await dispatch(compileSource({
      source: proof.leanSource,
      libraryPaths: proof.libraryPaths,
      mode: compileMode,
    }));
  }
  function cancelCompile() {
    cancelCurrentCompile();
  }

  // Reflect diagnostics into Monaco as inline markers (red/yellow squiggles).
  // Re-applied whenever diagnostics change.
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
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
  }, [diagnostics]);

  // Exposed on window so Diagnostics can jump cursor into this editor, and
  // so Playwright tests can set the editor value directly. `ready` flips to
  // true after onMount runs — consumers MUST wait for it before calling
  // jumpTo / setValue, otherwise the editor hasn't been created yet.
  (window as any).__ideEditor = {
    ready,
    monaco: monacoRef.current,
    getMarkers: (): unknown[] => {
      const monaco = monacoRef.current;
      const ed = editorRef.current;
      if (!monaco || !ed) return [];
      const model = ed.getModel();
      return model ? monaco.editor.getModelMarkers({ resource: model.uri }) : [];
    },
    jumpTo: (line: number, column: number) => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.focus();
      ed.setPosition({ lineNumber: line, column });
      ed.revealPositionInCenter({ lineNumber: line, column });
    },
    setValue: (text: string) => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.setValue(text);
    },
    getValue: (): string => editorRef.current?.getValue() ?? '',
  };

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
        {/* key per proof id: re-mount Monaco when switching proofs, so we
            can safely use uncontrolled mode (defaultValue). A controlled
            `value` prop would re-sync editor content on every render and
            clobber programmatic setValue calls. */}
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
            editorRef.current = editor;
            monacoRef.current = monaco;
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCompile);
            setReady(true);
          }}
          beforeMount={(monaco) => { registerLeanLanguage(monaco); }}
        />
      </div>
    </div>
  );
}
