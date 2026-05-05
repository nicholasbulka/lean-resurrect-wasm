import Graph from 'graphology';
import { extractImportsFromSource } from '../cm/leanLanguage';
import type { Project } from '../../slices/projectsSlice';

/**
 * Convert a Lean module path ("Lc.LiCriterion.Basic") to the file path
 * within the project ("Lc/LiCriterion/Basic.lean"). Returns null if the
 * module doesn't resolve to a file in the project (e.g., Mathlib imports).
 */
function moduleToFilePath(
  modulePath: string,
  filesByPath: Record<string, unknown>,
): string | null {
  const candidate = modulePath.split('.').join('/') + '.lean';
  if (candidate in filesByPath) return candidate;
  return null;
}

/** Pleasantly distinguish files by their top-level directory. */
function colorForPath(path: string): string {
  const seg = path.split('/')[0];
  // A simple deterministic palette keyed on first directory.
  const palette = [
    '#2d7dd2', // blue
    '#d2691e', // orange
    '#7d4ad2', // purple
    '#22a06b', // green
    '#c9357d', // pink
    '#a08020', // ochre
    '#347b8a', // teal
    '#955f3b', // brown
  ];
  let h = 0;
  for (let i = 0; i < seg.length; i++) h = (h * 31 + seg.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

export interface BuildResult {
  graph: Graph;
  /** Number of unresolved imports (point at modules outside the project). */
  externalImports: number;
  /** Total imports parsed across all files. */
  totalImports: number;
  /** Per-file: how many of its imports resolved within the project. */
  inProjectImportsByFile: Record<string, number>;
}

/**
 * Walk every file in the project, parse it, extract `import X.Y.Z`
 * statements, and build a graphology graph where:
 *   - nodes are file paths within the project
 *   - edges are `from` imports `to` (both must be project files)
 *
 * External imports (Mathlib, Init, etc.) are counted but not added as
 * nodes — the graph is intentionally project-internal so it stays
 * legible. A future iteration could add a "show external" toggle.
 */
export function buildImportGraph(project: Project): BuildResult {
  const g = new Graph({ multi: false, type: 'directed' });
  const filesByPath = project.files;
  let externalImports = 0;
  let totalImports = 0;
  const inProjectImportsByFile: Record<string, number> = {};

  // Pass 1: add nodes for every file. Position roughly grid-laid out so
  // forceAtlas2 has a sensible starting layout.
  const paths = Object.keys(filesByPath).sort();
  const cols = Math.max(1, Math.ceil(Math.sqrt(paths.length)));
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const x = (i % cols) - cols / 2;
    const y = Math.floor(i / cols) - cols / 2;
    g.addNode(path, {
      label: path.split('/').pop() ?? path,
      x: x + Math.random() * 0.1,
      y: y + Math.random() * 0.1,
      size: 4,
      color: colorForPath(path),
    });
  }

  // Pass 2: parse each file, extract imports, add edges.
  for (const path of paths) {
    const file = filesByPath[path];
    let imports: ReturnType<typeof extractImportsFromSource>;
    try { imports = extractImportsFromSource(file.content); }
    catch { imports = []; }
    let inProject = 0;
    for (const imp of imports) {
      totalImports++;
      const targetPath = moduleToFilePath(imp.modulePath, filesByPath);
      if (!targetPath) { externalImports++; continue; }
      if (targetPath === path) continue; // self-import (shouldn't happen but safe)
      if (!g.hasEdge(path, targetPath)) {
        g.addDirectedEdge(path, targetPath, {
          color: 'rgba(120,120,120,0.3)',
          size: 0.5,
        });
      }
      inProject++;
    }
    inProjectImportsByFile[path] = inProject;
  }

  return { graph: g, externalImports, totalImports, inProjectImportsByFile };
}
