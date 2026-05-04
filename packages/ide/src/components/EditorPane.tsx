import { useRef, useState, useEffect } from 'react';
import { basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { useAppDispatch, useAppSelector } from '../store';
import { updateLean } from '../slices/proofsSlice';
import { compileSource, cancelCurrentCompile } from '../slices/compileSlice';
import { LibraryPaths } from './LibraryPaths';
import { createCm6Bridge } from '../lib/editorBridge';
import { CodeMirror } from '../lib/cm/CodeMirror';
import { leanLanguage } from '../lib/cm/leanLanguage';
import { setLeanDiagnostics } from '../lib/cm/leanDiagnostics';

export function EditorPane() {
  const dispatch = useAppDispatch();
  const currentId = useAppSelector((s) => s.proofs.currentId);
  const proof = useAppSelector((s) => (currentId ? s.proofs.entities[currentId] : null));
  const status = useAppSelector((s) => s.compile.status);
  const compileMode = useAppSelector((s) => s.ui.compileMode);
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

  // Reflect compile diagnostics into the editor as inline markers. CM6's
  // lint state field is enabled implicitly by setDiagnostics.
  useEffect(() => {
    const view = cmViewRef.current;
    if (!view) return;
    setLeanDiagnostics(view, diagnostics);
  }, [diagnostics]);

  // window.__ideEditor: bridge for Diagnostics' jumpTo and Playwright tests.
  // `ready` flips after the underlying editor mounts.
  (window as any).__ideEditor = createCm6Bridge(cmViewRef, ready);

  const cmExtensions = [
    basicSetup,
    keymap.of([
      { key: 'Mod-Enter', run: () => { runCompileRef.current(); return true; } },
    ]),
    leanLanguage(),
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
        {/* key per proof id: re-mount the editor when switching proofs, so
            we can safely use uncontrolled mode. */}
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
      </div>
    </div>
  );
}
