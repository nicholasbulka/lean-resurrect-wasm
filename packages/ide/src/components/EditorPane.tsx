import { useRef, useState, useEffect } from 'react';
import { basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { useAppDispatch, useAppSelector } from '../store';
import { updateFileContent, getProjectOleansBundles } from '../slices/projectsSlice';
import { compileSource, cancelCurrentCompile, setProgress } from '../slices/compileSlice';
import { fetchDeltaBundle, getProjectCdnMeta } from '../lib/cdnLoader';
import { LibraryPaths } from './LibraryPaths';
import { createCm6Bridge } from '../lib/editorBridge';
import { CodeMirror } from '../lib/cm/CodeMirror';
import { leanLanguage } from '../lib/cm/leanLanguage';
import { setLeanDiagnostics } from '../lib/cm/leanDiagnostics';

export function EditorPane() {
  const dispatch = useAppDispatch();
  const projectId = useAppSelector((s) => s.projects.currentId);
  const project = useAppSelector((s) => (projectId ? s.projects.entities[projectId] : null));
  const filePath = project?.currentPath ?? null;
  const file = filePath && project ? project.files[filePath] : null;
  const status = useAppSelector((s) => s.compile.status);
  const compileMode = useAppSelector((s) => s.ui.compileMode);
  const cmViewRef = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);
  const diagnostics = useAppSelector((s) => s.compile.result?.diagnostics ?? []);

  // runCompile captures live project/file/status/compileMode. The CM6
  // keymap closure is created once at mount, so it must read through a ref
  // to see the latest function.
  const runCompileRef = useRef<() => void>(() => {});

  if (!project || !file) return <div className="pane"><div className="pane-body" /></div>;

  async function runCompile() {
    if (!project || !file || status === 'running') return;
    // The project's prebuilt oleans (CDN core shards, or a local project's
    // single bundle) are the stable CORE — staged once at worker init so a
    // pre-warmed spare is ready. The per-file DELTA (closure-prefetch) is
    // staged per compile.
    const coreBundles = compileMode === 'browser' ? getProjectOleansBundles(project.id) : [];
    // Demand-paging safety net: a CDN project's build/ base lets the worker
    // fetch any olean the closure-prefetch delta missed. Always wire it for
    // CDN projects, independent of the delta computation.
    const cdnMeta = compileMode === 'browser' ? getProjectCdnMeta(project.id) : undefined;
    const cdnBuildBase = cdnMeta ? `/cdn/projects/${encodeURIComponent(cdnMeta.slug)}/build` : null;
    // Test hook: force reliance on demand paging by skipping delta prefetch.
    const skipDelta = (window as any).__leanDisableDeltaPrefetch === true;
    let deltaBundles: Uint8Array[] = [];
    if (compileMode === 'browser' && !skipDelta) {
      try {
        const delta = await fetchDeltaBundle(
          project.id,
          file.content,
          (p) => dispatch(setProgress(p)),
        );
        if (delta) deltaBundles = [delta];
      } catch (e) {
        // Non-fatal: fall through to compile with whatever is staged; Lean
        // will report any unresolved imports (or demand paging covers them).
        console.warn('[ide] delta prefetch failed:', e);
      }
    }
    await dispatch(compileSource({
      source: file.content,
      libraryPaths: project.libraryPaths,
      mode: compileMode,
      coreBundles: compileMode === 'browser' ? coreBundles : undefined,
      coreKey: compileMode === 'browser' ? project.id : undefined,
      deltaBundles: compileMode === 'browser' ? deltaBundles : undefined,
      cdnBuildBase: compileMode === 'browser' ? cdnBuildBase : undefined,
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
        <strong>{file.path}</strong>
        <span style={{ color: 'var(--text-muted)' }}>{file.content.length} chars</span>
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
        {/* key={project.id}:{file.path}: re-mount the editor when switching
            files or projects so we can safely use uncontrolled mode. */}
        <CodeMirror
          key={`${project.id}:${file.path}`}
          initialValue={file.content}
          onChange={(v) => dispatch(updateFileContent({ projectId: project.id, path: file.path, content: v }))}
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
