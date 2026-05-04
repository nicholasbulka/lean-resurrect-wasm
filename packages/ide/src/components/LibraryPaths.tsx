import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { addLibraryPath, removeLibraryPath, updateLibraryPath } from '../slices/projectsSlice';

/**
 * BYOML: per-project list of extra library roots. Passed to the compile
 * endpoint as LEAN_EXTRA_PATH so the compiled-in install-prefix stdlib
 * stays intact while a user's own oleans are searched first.
 */
export function LibraryPaths() {
  const dispatch = useAppDispatch();
  const currentId = useAppSelector((s) => s.projects.currentId);
  const paths = useAppSelector((s) => (currentId ? s.projects.entities[currentId]?.libraryPaths ?? [] : []));
  const [draft, setDraft] = useState('');
  if (!currentId) return null;

  function commitAdd() {
    const v = draft.trim();
    if (!v) return;
    dispatch(addLibraryPath({ id: currentId!, path: v }));
    setDraft('');
  }

  return (
    <div className="lib-paths">
      <div className="lib-paths-title">BYOML — extra library roots (prepended to <code>LEAN_PATH</code>)</div>
      {paths.length === 0 && <div className="lib-paths-empty">no extra libs — stdlib only</div>}
      {paths.map((p, i) => (
        <div key={i} className="lib-paths-row">
          <input
            value={p}
            spellCheck={false}
            onChange={(e) => dispatch(updateLibraryPath({ id: currentId, index: i, path: e.target.value }))}
            placeholder="/abs/path/to/my/.lake/build/lib"
          />
          <button title="remove" onClick={() => dispatch(removeLibraryPath({ id: currentId, index: i }))}>−</button>
        </div>
      ))}
      <div className="lib-paths-row">
        <input
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitAdd(); }}
          placeholder="/abs/path/to/lib-root   (press Enter)"
        />
        <button onClick={commitAdd} disabled={!draft.trim()}>+</button>
      </div>
    </div>
  );
}
