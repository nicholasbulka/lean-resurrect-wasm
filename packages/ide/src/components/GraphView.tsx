import { useEffect, useMemo, useRef, useState } from 'react';
import type Sigma from 'sigma';
import { useAppDispatch, useAppSelector } from '../store';
import { selectFile } from '../slices/projectsSlice';
import { SigmaGraph } from '../lib/graph/SigmaGraph';
import { buildImportGraph } from '../lib/graph/buildImportGraph';

/**
 * Lean import dependency graph for the active project. Each node is a
 * .lean file in the project; each directed edge is `from imports to`,
 * filtered to imports that resolve to files within the project. External
 * imports (Mathlib, Init, etc.) are counted in the legend but not drawn,
 * so the graph stays legible.
 *
 * Click a node = open that file in the editor.
 */
export function GraphView() {
  const dispatch = useAppDispatch();
  const projectId = useAppSelector((s) => s.projects.currentId);
  const project = useAppSelector((s) => (projectId ? s.projects.entities[projectId] : null));
  const sigmaRef = useRef<Sigma | null>(null);
  const [stats, setStats] = useState<{ files: number; edges: number; external: number; tookMs: number } | null>(null);

  // Build the graph when the project changes. Cache via useMemo —
  // changing the active file shouldn't trigger a rebuild.
  const built = useMemo(() => {
    if (!project) return null;
    const t0 = performance.now();
    const result = buildImportGraph(project);
    const tookMs = Math.round(performance.now() - t0);
    return { ...result, tookMs };
  }, [project?.id, Object.keys(project?.files ?? {}).length]);

  useEffect(() => {
    if (!built) { setStats(null); return; }
    setStats({
      files: built.graph.order,
      edges: built.graph.size,
      external: built.externalImports,
      tookMs: built.tookMs,
    });
  }, [built]);

  // Wire click-to-open once Sigma is mounted.
  const onSigma = (sigma: Sigma) => {
    sigmaRef.current = sigma;
    sigma.on('clickNode', ({ node }) => {
      if (!project) return;
      dispatch(selectFile({ projectId: project.id, path: node }));
    });
  };

  if (!project) {
    return <div className="graph-empty">no project selected</div>;
  }
  if (!built) return null;

  return (
    <div className="graph-pane">
      <div className="graph-stats">
        <span><strong>{stats?.files}</strong> files</span>
        <span><strong>{stats?.edges}</strong> imports drawn</span>
        <span>{stats?.external} external (not drawn)</span>
        <span style={{ color: 'var(--text-muted)' }}>{stats?.tookMs}ms parse</span>
      </div>
      <div className="graph-canvas">
        <SigmaGraph
          key={project.id}
          graph={built.graph}
          settings={{ renderLabels: true, labelSize: 11 }}
          onSigma={onSigma}
        />
      </div>
    </div>
  );
}
