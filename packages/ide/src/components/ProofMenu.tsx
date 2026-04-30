import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { addProof, deleteProof, renameProof, selectProof } from '../slices/proofsSlice';
import { setView, setCompileMode, type CompileMode } from '../slices/uiSlice';

export function ProofMenu() {
  const dispatch = useAppDispatch();
  const { entities, ids, currentId } = useAppSelector((s) => s.proofs);
  const view = useAppSelector((s) => s.ui.view);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  function startRename(id: string) {
    setRenamingId(id);
    setRenameDraft(entities[id]?.name ?? '');
  }
  function commitRename() {
    if (renamingId) dispatch(renameProof({ id: renamingId, name: renameDraft.trim() }));
    setRenamingId(null);
  }

  return (
    <nav className="menu" aria-label="proof menu">
      <h1>Lean IDE</h1>

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

      <div style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 4px' }} />

      {ids.map((id) => {
        const proof = entities[id];
        const isActive = id === currentId;
        if (renamingId === id) {
          return (
            <input
              key={id}
              className="inline-rename"
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingId(null);
              }}
            />
          );
        }
        return (
          <button
            key={id}
            className={'tab' + (isActive ? ' active' : '')}
            onClick={() => dispatch(selectProof(id))}
            onDoubleClick={() => startRename(id)}
            title={proof.name + ' — double-click to rename'}
          >
            {proof.name}
          </button>
        );
      })}
      <button onClick={() => dispatch(addProof({}))} title="new proof">+</button>
      {currentId && ids.length > 0 && (
        <button
          onClick={() => {
            if (confirm('delete "' + entities[currentId!].name + '"?')) {
              dispatch(deleteProof(currentId!));
            }
          }}
          title="delete current proof"
        >
          −
        </button>
      )}
      <div className="spacer" />
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
