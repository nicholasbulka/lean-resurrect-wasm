// CDN closure-prefetch loader.
//
// Holds per-project import-graph + core-module metadata (the
// closure-prefetch inputs) outside Redux — like setProjectOleansBundles, the
// graph is ~1.3 MB and not worth serializing. On compile we parse the active
// file's imports, compute the delta vs the staged core, fetch each delta
// module's olean parts directly from the CDN build/ tree, and assemble them
// into an in-memory bundle in the SAME wire format the worker already stages.

import { parseImports, computeDelta, moduleToPath } from './closure';
import type { CompileProgress } from '../slices/compileSlice';

/** Olean part extensions a module may ship. Not every module has all five. */
const OLEAN_PARTS = ['olean', 'olean.private', 'olean.server', 'ir', 'ilean'] as const;

/** Bounded-concurrency fetch fan-out for delta modules. */
const FETCH_CONCURRENCY = 12;

export interface ProjectCdnMeta {
  /** CDN slug whose build/ tree holds per-module oleans. */
  slug: string;
  /** module -> direct deps (import-graph.json `graph`). */
  graph: Record<string, string[]>;
  /** Always-staged base layer (core-modules.json `modules`). */
  coreModules: Set<string>;
}

// Side-table keyed by Redux project id. Populated on CDN import when the
// project ships an import-graph; absent for plain "stage whole bundle"
// projects, in which case the loader falls back to the full bundle path.
const __cdnMetaByProject = new Map<string, ProjectCdnMeta>();

export function setProjectCdnMeta(projectId: string, meta: ProjectCdnMeta | null): void {
  if (meta) __cdnMetaByProject.set(projectId, meta);
  else __cdnMetaByProject.delete(projectId);
}

export function getProjectCdnMeta(projectId: string): ProjectCdnMeta | undefined {
  return __cdnMetaByProject.get(projectId);
}

/** Fetched olean part: lib-root-relative forward-slash path + bytes. */
interface StagedEntry {
  path: string;
  bytes: Uint8Array;
}

/**
 * Fetch one module's olean parts from `/cdn/projects/<slug>/build/<Path>.<ext>`.
 * Tolerates 404 — many modules lack `.ir`/`.olean.server`/etc. Returns every
 * part that exists.
 */
async function fetchModuleParts(slug: string, dotted: string): Promise<StagedEntry[]> {
  const stem = moduleToPath(dotted); // e.g. Mathlib/Data/Real/Basic
  const base = `/cdn/projects/${encodeURIComponent(slug)}/build/${stem}`;
  const results = await Promise.all(
    OLEAN_PARTS.map(async (ext) => {
      try {
        const r = await fetch(`${base}.${ext}`);
        if (!r.ok) return null; // 404 etc — part doesn't exist for this module
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength === 0) return null;
        return { path: `${stem}.${ext}`, bytes: buf } as StagedEntry;
      } catch (_) {
        return null;
      }
    }),
  );
  return results.filter((x): x is StagedEntry => x !== null);
}

/**
 * Pack staged entries into the worker's bundle wire format:
 *   [u32 count][per entry: u16 pathLen, path bytes, u32 dataLen, data bytes]
 * Paths are forward-slash, relative to the lib root (/work/lib/lean).
 */
function packBundle(entries: StagedEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const encoded = entries.map((e) => ({ pathBytes: enc.encode(e.path), bytes: e.bytes }));
  let total = 4;
  for (const e of encoded) total += 2 + e.pathBytes.length + 4 + e.bytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  dv.setUint32(off, encoded.length, true); off += 4;
  for (const e of encoded) {
    dv.setUint16(off, e.pathBytes.length, true); off += 2;
    out.set(e.pathBytes, off); off += e.pathBytes.length;
    dv.setUint32(off, e.bytes.length, true); off += 4;
    out.set(e.bytes, off); off += e.bytes.length;
  }
  return out;
}

export type OnProgress = (p: CompileProgress) => void;

/**
 * Compute the per-file delta and fetch it from the CDN, returning a single
 * in-memory bundle (wire format) staged alongside the core. Returns `null`
 * when the project has no CDN closure metadata (fall back to the existing
 * "stage whole bundle" path) or when the delta is empty (core already covers
 * everything the file needs).
 */
export async function fetchDeltaBundle(
  projectId: string,
  source: string,
  onProgress?: OnProgress,
): Promise<Uint8Array | null> {
  const meta = __cdnMetaByProject.get(projectId);
  if (!meta) return null; // not a closure-prefetch project → caller falls back

  const fileImports = parseImports(source);
  const delta = computeDelta(fileImports, meta.graph, meta.coreModules);
  if (delta.length === 0) return null; // core covers everything

  onProgress?.({
    phase: 'fetching-oleans',
    current: 0,
    total: delta.length,
    message: `fetching ${delta.length} module(s) beyond core`,
  });

  const staged: StagedEntry[] = [];
  let done = 0;
  // Bounded-concurrency worker pool over the delta module list.
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= delta.length) return;
      const parts = await fetchModuleParts(meta!.slug, delta[idx]);
      for (const p of parts) staged.push(p);
      done++;
      if (done % 8 === 0 || done === delta.length) {
        onProgress?.({
          phase: 'fetching-oleans',
          current: done,
          total: delta.length,
          message: `fetched ${done}/${delta.length} delta module(s)`,
        });
      }
    }
  }
  const pool = Array.from({ length: Math.min(FETCH_CONCURRENCY, delta.length) }, worker);
  await Promise.all(pool);

  onProgress?.({
    phase: 'staging',
    current: delta.length,
    total: delta.length,
    message: `staging ${staged.length} delta olean part(s)`,
  });

  if (staged.length === 0) return null;
  return packBundle(staged);
}
