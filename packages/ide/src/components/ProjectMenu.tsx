import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  addScratchProject, deleteProject, importProject, renameProject, selectProject,
  setProjectOleansBundle, setProjectOleansBundles,
} from '../slices/projectsSlice';
import { setView, setCompileMode, type CompileMode } from '../slices/uiSlice';
import { setProjectCdnMeta } from '../lib/cdnLoader';
import { transitiveClosure } from '../lib/closure';

const DEFAULT_LICRITERION_PATH =
  '/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion';

// Fetch a manifest-described sharded bundle (or a single bundle) as an array
// of standalone bundle byte-blobs. Same wire format/shape for both the project
// `oleans.bundle*` and the `core.bundle*` (closure-prefetch base layer).
// Returns [] if neither the manifest nor the single bundle exists.
async function fetchShardedBundle(base: string, prefix: string): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const mR = await fetch(`${base}/${prefix}.manifest.json`);
  if (mR.ok) {
    const shardManifest = await mR.json() as { shards: { name: string }[] };
    const shardResps = await Promise.all(
      shardManifest.shards.map((sh) => fetch(`${base}/${encodeURIComponent(sh.name)}`)),
    );
    for (let i = 0; i < shardResps.length; i++) {
      if (!shardResps[i].ok) {
        throw new Error(`shard fetch failed for ${shardManifest.shards[i].name}: ${shardResps[i].status}`);
      }
    }
    const bufs = await Promise.all(shardResps.map((r) => r.arrayBuffer()));
    for (const b of bufs) { const u = new Uint8Array(b); if (u.byteLength > 4) out.push(u); }
    return out;
  }
  const bR = await fetch(`${base}/${prefix}`);
  if (bR.ok) {
    const u = new Uint8Array(await bR.arrayBuffer());
    if (u.byteLength > 4) out.push(u);
  }
  return out;
}

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
        'Available wasm32-compiled projects:\n\n' + summary + '\n' +
        '\nEnter project id, OR a comma-separated list to combine bundles\n' +
        '(e.g. "aesop-v4.27.0-2026-04,batteries-v4.27.0-2026-04").\n' +
        'The first slug becomes the project (its sources are loaded);\n' +
        'every slug\'s oleans.bundle is staged into MEMFS.\n',
        projects[0]?.id ?? ''
      );
      if (!pick) return;
      const slugs = pick.split(',').map((s) => s.trim()).filter(Boolean);
      const primary = projects.find((p) => p.id === slugs[0]);
      if (!primary) { alert('No such project on CDN: ' + slugs[0]); return; }
      // Validate all slugs first.
      for (const s of slugs) {
        if (!projects.find((p) => p.id === s)) { alert('No such project on CDN: ' + s); return; }
      }
      // Fetch primary sources + every slug's oleans (sharded or single).
      const srcR = await fetch(`/cdn/projects/${encodeURIComponent(primary.id)}/sources.json`);
      if (!srcR.ok) { alert('CDN sources fetch failed: ' + srcR.status); return; }
      const manifest = await srcR.json() as { name: string; files: { path: string; content: string }[] };

      // Closure-prefetch: a slug that ships an import-graph.json + core base
      // layer (core.bundle*) stages ONLY the core up front and fetches each
      // file's additional transitive deps on demand at compile time. This is
      // the only way Mathlib (~4 GB of oleans, over the wasm32 MEMFS ceiling)
      // can be used in-browser. Probe the PRIMARY slug for an import-graph;
      // if present, take the closure-prefetch path. Otherwise fall back to
      // staging the whole oleans.bundle*/shards as before (small libs).
      const primaryBase = `/cdn/projects/${encodeURIComponent(primary.id)}`;
      const graphR = await fetch(`${primaryBase}/import-graph.json`);
      const closurePrefetch = graphR.ok;

      // A slug ships its oleans either as a single oleans.bundle or, for
      // large libraries, as ~500 MB shards described by a manifest. Each shard
      // is a standalone bundle, so we collect them all into one flat array the
      // worker stages in turn.
      const bundleBytes: Uint8Array[] = [];
      try {
        for (const s of slugs) {
          const base = `/cdn/projects/${encodeURIComponent(s)}`;
          // For the primary slug in closure-prefetch mode, stage core.bundle*
          // (the always-on base layer) instead of the full oleans.bundle*.
          const prefix = (closurePrefetch && s === primary.id) ? 'core.bundle' : 'oleans.bundle';
          const blobs = await fetchShardedBundle(base, prefix);
          for (const u of blobs) bundleBytes.push(u);
        }
      } catch (e: any) {
        alert('CDN oleans fetch failed: ' + (e?.message ?? String(e)));
        return;
      }

      // Parse the closure-prefetch metadata before dispatching the project so
      // we can stash it under the new project id below.
      let cdnMeta: { slug: string; graph: Record<string, string[]>; coreModules: Set<string> } | null = null;
      if (closurePrefetch) {
        try {
          const graphDoc = await graphR.json() as { graph: Record<string, string[]> };
          const graph = graphDoc.graph ?? {};
          // core-modules.json is the authoritative core set. If the sibling
          // agent hasn't shipped it yet, fall back to the closure of the
          // declared coreRoot (Mathlib.Init) so delta computation still works.
          let coreModules: Set<string>;
          const coreR = await fetch(`${primaryBase}/core-modules.json`);
          if (coreR.ok) {
            const coreDoc = await coreR.json() as { coreRoot?: string; modules: string[] };
            coreModules = new Set(coreDoc.modules ?? []);
          } else {
            coreModules = transitiveClosure(['Mathlib.Init'], graph);
          }
          cdnMeta = { slug: primary.id, graph, coreModules };
        } catch (_) {
          // Graph/core parse failure → behave like a non-prefetch project.
          cdnMeta = null;
        }
      }

      dispatch(importProject({
        name: slugs.length > 1 ? `${manifest.name} (+${slugs.length - 1})` : manifest.name,
        root: 'cdn://' + slugs.join('+'),
        files: manifest.files,
      }));
      const id = (window as any).__store?.getState()?.projects?.currentId;
      if (id && bundleBytes.length) setProjectOleansBundles(id, bundleBytes);
      if (id) setProjectCdnMeta(id, cdnMeta);
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
