import { useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useAppDispatch, useAppSelector } from '../store';
import { updateLean } from '../slices/proofsSlice';
import { compileSource } from '../slices/compileSlice';
import { LibraryPaths } from './LibraryPaths';

export function EditorPane() {
  const dispatch = useAppDispatch();
  const currentId = useAppSelector((s) => s.proofs.currentId);
  const proof = useAppSelector((s) => (currentId ? s.proofs.entities[currentId] : null));
  const status = useAppSelector((s) => s.compile.status);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [ready, setReady] = useState(false);

  if (!proof) return <div className="pane"><div className="pane-body" /></div>;

  async function runCompile() {
    if (!proof || status === 'running') return;
    await dispatch(compileSource({ source: proof.leanSource, libraryPaths: proof.libraryPaths }));
  }

  // Exposed on window so Diagnostics can jump cursor into this editor, and
  // so Playwright tests can set the editor value directly. `ready` flips to
  // true after onMount runs — consumers MUST wait for it before calling
  // jumpTo / setValue, otherwise the editor hasn't been created yet.
  (window as any).__ideEditor = {
    ready,
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
        <button
          onClick={runCompile}
          disabled={status === 'running'}
          style={{
            padding: '2px 10px', border: '1px solid var(--accent)', borderRadius: 3,
            background: 'var(--accent)', color: 'white',
            cursor: status === 'running' ? 'progress' : 'pointer', font: 'inherit',
          }}
        >
          {status === 'running' ? 'compiling…' : 'compile'} <kbd>⌘↵</kbd>
        </button>
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
          language="plaintext"
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
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCompile);
            setReady(true);
          }}
        />
      </div>
    </div>
  );
}
