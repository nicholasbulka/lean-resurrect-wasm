// Node smoke test for the closure-prefetch util. Run:
//   cd packages/ide && npx tsx src/lib/closure.test.mjs
// (tsx transpiles the .ts import on the fly; the module has no DOM deps.)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseImports, transitiveClosure, computeDelta, moduleToPath } from './closure.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GRAPH_PATH = resolve(
  here,
  '../../../../cdn/projects/mathlib-v4.27.0-2026-04/import-graph.json',
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  - ${name}${detail ? ' (' + detail + ')' : ''}`);
  } else {
    console.log(`  FAIL - ${name}${detail ? ' (' + detail + ')' : ''}`);
    failures++;
  }
}

console.log('# parseImports');
{
  const src = `
-- a leading comment
import Foo.Bar
public import Baz.Qux
private import Std.Data.HashMap
meta import Lean.Elab
import all Mathlib.Tactic
/- import Commented.Out
   import Also.Commented -/
public meta import Multi.Modifier
def x := 1
import TooLate.ShouldStillMatchHeaderStyle
`;
  const imps = parseImports(src);
  check('extracts plain import', imps.includes('Foo.Bar'));
  check('extracts public import', imps.includes('Baz.Qux'));
  check('extracts private import', imps.includes('Std.Data.HashMap'));
  check('extracts meta import', imps.includes('Lean.Elab'));
  check('extracts import all', imps.includes('Mathlib.Tactic'));
  check('extracts multi-modifier', imps.includes('Multi.Modifier'));
  check('ignores block-commented imports', !imps.includes('Commented.Out') && !imps.includes('Also.Commented'));
  check('dedups', new Set(imps).size === imps.length, 'count=' + imps.length);
  console.log('    -> ' + JSON.stringify(imps));
}

console.log('# moduleToPath');
check('dotted -> slash', moduleToPath('Mathlib.Data.Real.Basic') === 'Mathlib/Data/Real/Basic');

if (!existsSync(GRAPH_PATH)) {
  console.log('# graph tests SKIPPED — import-graph.json not on disk at ' + GRAPH_PATH);
} else {
  console.log('# transitiveClosure against real import-graph.json');
  const doc = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'));
  const graph = doc.graph;
  check('graph parsed', graph && typeof graph === 'object', Object.keys(graph).length + ' modules');

  const closure = transitiveClosure(['Mathlib.Data.Real.Basic'], graph);
  check(
    'closure(Mathlib.Data.Real.Basic) ~ 1500',
    closure.size >= 1200 && closure.size <= 1900,
    'size=' + closure.size,
  );
  check('closure includes the root', closure.has('Mathlib.Data.Real.Basic'));

  // Stand-in core set: closure of Mathlib.Init (core-modules.json not yet on
  // disk). computeDelta should subtract it from a file's closure.
  const standInCore = transitiveClosure(['Mathlib.Init'], graph);
  console.log('    stand-in core (closure of Mathlib.Init) size=' + standInCore.size);
  const delta = computeDelta(['Mathlib.Data.Real.Basic'], graph, standInCore);
  check('delta is sorted', delta.every((v, i) => i === 0 || delta[i - 1] <= v));
  check('delta excludes core members', delta.every((m) => !standInCore.has(m)));
  check(
    'delta + core covers full closure',
    delta.length + [...closure].filter((m) => standInCore.has(m)).length === closure.size,
    'delta=' + delta.length + ' coreHit=' + [...closure].filter((m) => standInCore.has(m)).length,
  );
  console.log('    delta size=' + delta.length + ' (closure ' + closure.size + ' minus core overlap)');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
