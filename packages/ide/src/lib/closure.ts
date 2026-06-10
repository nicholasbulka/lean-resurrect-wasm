// Closure-prefetch helpers for the browser IDE loader.
//
// Mathlib's full olean set is ~4 GB — larger than the wasm32 MEMFS ceiling.
// Instead of staging everything, we stage a common "core" base layer once and
// then, per compile, fetch only the additional modules the active file's
// imports transitively need (the "delta"). These pure functions compute that
// delta from the project's import graph; they are Node-unit-testable and have
// no DOM/worker dependencies.

/**
 * Extract dotted module names from a Lean source file's `import` lines.
 *
 * Lean v4.27 import syntax (see docs/lean4-reference + vendor/lean4-src):
 *   import Foo.Bar
 *   public import Foo.Bar
 *   private import Foo.Bar
 *   meta import Foo.Bar
 *   import all Foo.Bar            (and modifier combinations of the above)
 *
 * The leading modifiers `public` / `private` / `meta` may appear (zero or
 * more) before the `import` keyword; an optional `all` may follow it. We only
 * care about the dotted module name itself.
 *
 * Comment handling: we strip `--` line comments and `/- ... -/` block comments
 * (including nesting) before scanning, so commented-out imports are ignored.
 * Imports must appear at the top of a Lean file before any command, so a
 * line-oriented scan after comment stripping is sufficient and avoids pulling
 * in identifiers from `open`/`namespace`/term-level code.
 */
export function parseImports(source: string): string[] {
  const cleaned = stripComments(source);
  const out: string[] = [];
  const seen = new Set<string>();
  // Anchored at line start (after optional leading whitespace). Modifiers are
  // each optional and may repeat. `all` is an optional keyword after `import`.
  const re =
    /^[ \t]*(?:(?:public|private|meta)[ \t]+)*import[ \t]+(?:all[ \t]+)?([A-Za-z_][A-Za-z0-9_.À-￿]*)/;
  for (const rawLine of cleaned.split('\n')) {
    const m = re.exec(rawLine);
    if (!m) continue;
    const name = m[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Remove Lean comments so commented-out imports don't get picked up.
 * Handles `--` line comments and nested `/- ... -/` block comments.
 * String literals are not specially handled — import lines never contain
 * strings, so this is safe for the import header we care about.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let block = 0; // block-comment nesting depth
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = i + 1 < n ? source[i + 1] : '';
    if (block > 0) {
      if (c === '/' && d === '-') { block++; i += 2; continue; }
      if (c === '-' && d === '/') { block--; i += 2; continue; }
      // Preserve newlines so the line-oriented scan stays aligned.
      if (c === '\n') out += '\n';
      i++;
      continue;
    }
    if (c === '/' && d === '-') { block++; i += 2; continue; }
    if (c === '-' && d === '-') {
      // Line comment: skip to end of line (keep the newline).
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Transitive closure of `roots` over `graph` (module -> direct deps), inclusive
 * of the roots themselves. Modules absent from the graph contribute nothing
 * (they have no outgoing edges) but are still included in the result set so the
 * loader will attempt to fetch them.
 */
export function transitiveClosure(
  roots: string[],
  graph: Record<string, string[]>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const m = stack.pop() as string;
    if (seen.has(m)) continue;
    seen.add(m);
    const deps = graph[m];
    if (deps) {
      for (const d of deps) if (!seen.has(d)) stack.push(d);
    }
  }
  return seen;
}

/**
 * Modules the loader must fetch per-file beyond the always-staged core:
 *   transitiveClosure(fileImports) \ coreModules, sorted.
 */
export function computeDelta(
  fileImports: string[],
  graph: Record<string, string[]>,
  coreModules: Set<string>,
): string[] {
  const closure = transitiveClosure(fileImports, graph);
  const delta: string[] = [];
  for (const m of closure) {
    if (!coreModules.has(m)) delta.push(m);
  }
  delta.sort();
  return delta;
}

/** Dotted module name -> lib-root-relative path stem (forward slashes). */
export function moduleToPath(dotted: string): string {
  return dotted.replace(/\./g, '/');
}
