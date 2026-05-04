import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  addScratchProject, deleteProject, importProject, renameProject, selectProject,
} from '../slices/projectsSlice';
import { setView, setCompileMode, type CompileMode } from '../slices/uiSlice';

const DEFAULT_LICRITERION_PATH =
  '/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion';

export function ProjectMenu() {
  const dispatch = useAppDispatch();
  const { entities, ids, currentId } = useAppSelector((s) => s.projects);
  const view = useAppSelector((s) => s.ui.view);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');

  const current = currentId ? entities[currentId] : null;

  function startRename() {
    if (!current) return;
    setRenameDraft(current.name);
    setRenaming(true);
  }
  function commitRename() {
    if (currentId) dispatch(renameProject({ id: currentId, name: renameDraft.trim() }));
    setRenaming(false);
  }

  async function importFromPath() {
    const root = prompt('Project root (absolute path):', DEFAULT_LICRITERION_PATH);
    if (!root) return;
    setBusy(true);
    try {
      const r = await fetch('/api/project/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      });
      if (!r.ok) {
        alert('import failed: ' + r.status + ' ' + (await r.text()));
        return;
      }
      const { name, root: scannedRoot, files } = await r.json();
      dispatch(importProject({ name, root: scannedRoot, files }));
    } catch (e: any) {
      alert('import error: ' + (e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <nav className="menu" aria-label="project menu">
      <h1>Lean IDE</h1>

      {renaming ? (
        <input
          className="project-rename"
          autoFocus
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <select
          className="project-select"
          value={currentId ?? ''}
          onChange={(e) => dispatch(selectProject(e.target.value))}
          title={current?.name ?? ''}
          aria-label="select project"
        >
          {ids.map((id) => {
            const p = entities[id];
            const fileCount = p ? Object.keys(p.files).length : 0;
            return (
              <option key={id} value={id}>
                {p?.name ?? '(unnamed)'}
                {fileCount > 1 ? ` — ${fileCount} files` : ''}
              </option>
            );
          })}
        </select>
      )}

      <button onClick={() => dispatch(addScratchProject(undefined))} title="new scratch project">+ new</button>
      <button onClick={importFromPath} disabled={busy} title="import a project from disk">
        {busy ? 'importing…' : '↓ import…'}
      </button>
      {current && (
        <button onClick={startRename} title="rename current project">✎ rename</button>
      )}
      {current && ids.length > 0 && (
        <button
          onClick={() => {
            if (confirm(`delete "${current.name}"?`)) dispatch(deleteProject(current.id));
          }}
          title="delete current project"
        >
          ✕ delete
        </button>
      )}

      <div className="spacer" />

      <a
        href="#/editor"
        className={view === 'editor' ? 'active' : ''}
        onClick={(e) => { e.preventDefault(); dispatch(setView('editor')); }}
      >
        Editor
      </a>
      <a
        href="#/architecture"
        className={view === 'architecture' ? 'active' : ''}
        onClick={(e) => { e.preventDefault(); dispatch(setView('architecture')); }}
      >
        Architecture
      </a>

      <CompileModeToggle />
    </nav>
  );
}

function CompileModeToggle() {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.compileMode);
  return (
    <label className="compile-mode" title="Where compile runs">
      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>compile:</span>
      <select
        value={mode}
        onChange={(e) => dispatch(setCompileMode(e.target.value as CompileMode))}
        style={{
          padding: '2px 6px', font: 'inherit', border: '1px solid var(--border)',
          borderRadius: 3, background: 'white',
        }}
      >
        <option value="server">server (Node WASM)</option>
        <option value="browser">browser (in-page WASM)</option>
      </select>
    </label>
  );
}
