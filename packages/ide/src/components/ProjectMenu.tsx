import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  addScratchProject, deleteProject, importProject, renameProject, selectProject,
  setProjectOleansBundle,
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
      // Fetch the project's prebuilt oleans bundle (.lake/build/lib/lean)
      // so the in-browser compiler can resolve project-internal imports
      // (e.g. `import Lc.LiCriterion.Basic`). Three outcomes:
      //   200: bundle staged, project-internal imports will resolve.
      //   200 + empty bundle: project has no .lake — compile will fail
      //     on project-internal imports (same as a never-built project).
      //   422: project oleans built with an incompatible Lean toolchain
      //     (typically native x86_64 vs our wasm32). Surface a clear
      //     warning so the user knows compile WILL fail with their
      //     prebuilt oleans, regardless of what they do.
      try {
        const bundleR = await fetch('/api/project/oleans', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: scannedRoot }),
        });
        if (bundleR.status === 422) {
          const info = await bundleR.json();
          const lines = [
            'Project imported, but its prebuilt oleans cannot be used.',
            '',
            info.message ?? 'incompatible toolchain',
            '',
            'Mismatch:',
            ...(info.reasons ?? []).map((r: string) => '  • ' + r),
            '',
            `Sample file: ${info.sampleFile}`,
            `Total oleans: ${info.oleanCount}`,
            '',
            'Files will open in the editor, but compiles that import',
            'project-internal modules (e.g. Lc.*, Hadamard.*) will fail',
            'with "incompatible header" until the project is rebuilt with',
            'the wasm32 toolchain that ships with this IDE.',
          ].join('\n');
          alert(lines);
        } else if (bundleR.ok) {
          const bytes = new Uint8Array(await bundleR.arrayBuffer());
          if (bytes.byteLength > 4) {
            const id = (window as any).__store?.getState()?.projects?.currentId;
            if (id) setProjectOleansBundle(id, bytes);
          }
        }
      } catch (_) { /* non-fatal */ }
    } catch (e: any) {
      alert('import error: ' + (e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  }

  // Pull a project from the CDN stub (server's /cdn/projects/<id>/...).
  // CDN-hosted projects ship pre-compiled wasm32 oleans, so the browser-mode
  // compile path can elaborate them directly with no local build step.
  // Single round-trip: list available, prompt user, fetch sources + oleans.
  async function importFromCdn() {
    setBusy(true);
    try {
      const listR = await fetch('/cdn/projects');
      if (!listR.ok) { alert('CDN list failed: ' + listR.status); return; }
      const { projects } = await listR.json() as { projects: { id: string; name: string; sourceCount: number; oleansBundleBytes: number }[] };
      if (!projects.length) {
        alert('No projects available on the CDN. Add one under cdn/projects/<slug>/.');
        return;
      }
      const summary = projects
        .map((p, i) => `  ${i + 1}. ${p.id} — ${p.sourceCount} files, ${(p.oleansBundleBytes / 1048576).toFixed(1)} MB oleans`)
        .join('\n');
      const pick = prompt(
        'Available wasm32-compiled projects:\n\n' + summary + '\n\nEnter project id:',
        projects[0]?.id ?? ''
      );
      if (!pick) return;
      const proj = projects.find((p) => p.id === pick);
      if (!proj) { alert('No such project on CDN: ' + pick); return; }
      const [srcR, bundleR] = await Promise.all([
        fetch(`/cdn/projects/${encodeURIComponent(proj.id)}/sources.json`),
        fetch(`/cdn/projects/${encodeURIComponent(proj.id)}/oleans.bundle`),
      ]);
      if (!srcR.ok) { alert('CDN sources fetch failed: ' + srcR.status); return; }
      if (!bundleR.ok) { alert('CDN oleans fetch failed: ' + bundleR.status); return; }
      const manifest = await srcR.json() as { name: string; files: { path: string; content: string }[] };
      const bundleBytes = new Uint8Array(await bundleR.arrayBuffer());
      dispatch(importProject({
        name: manifest.name,
        root: 'cdn://' + proj.id,
        files: manifest.files,
      }));
      if (bundleBytes.byteLength > 4) {
        const id = (window as any).__store?.getState()?.projects?.currentId;
        if (id) setProjectOleansBundle(id, bundleBytes);
      }
    } catch (e: any) {
      alert('CDN import error: ' + (e?.message ?? String(e)));
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
      <button onClick={importFromPath} disabled={busy} title="import a project from disk (sources only — oleans must be wasm32-built)">
        {busy ? 'importing…' : '↓ from disk…'}
      </button>
      <button onClick={importFromCdn} disabled={busy} title="download a wasm32-prebuilt project from the CDN">
        {busy ? '…' : '☁ from CDN…'}
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
