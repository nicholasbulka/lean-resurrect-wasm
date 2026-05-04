import { readFileSync } from 'node:fs';
import { buildParser } from '../../packages/ide/node_modules/@lezer/generator/dist/index.js';
import { ExternalTokenizer } from '../../packages/ide/node_modules/@lezer/lr/dist/index.js';

const grammarSrc = readFileSync('./packages/ide/src/lib/cm/lean.grammar', 'utf8');
const parser = buildParser(grammarSrc, {
  externalTokenizer: (name, terms) => {
    const SLASH = 47, DASH = 45, BANG = 33;
    const { BlockComment, DocBlockComment, ModuleDocComment } = terms;
    return new ExternalTokenizer((input) => {
      if (input.next !== SLASH || input.peek(1) !== DASH) return;
      let token, prefixLen;
      const after = input.peek(2);
      if (after === BANG) { token = ModuleDocComment; prefixLen = 3; }
      else if (after === DASH) { token = DocBlockComment; prefixLen = 3; }
      else { token = BlockComment; prefixLen = 2; }
      for (let i = 0; i < prefixLen; i++) input.advance();
      let depth = 1;
      while (depth > 0 && input.next >= 0) {
        if (input.next === SLASH && input.peek(1) === DASH) { depth++; input.advance(); input.advance(); }
        else if (input.next === DASH && input.peek(1) === SLASH) { depth--; input.advance(); input.advance(); }
        else input.advance();
      }
      input.acceptToken(token);
    });
  },
});

const files = [
  '/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion/Util/ComplexBinet2.lean',
  '/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion/Lc/Stirling.lean',
  '/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion/Util/BorelCaratheodory.lean',
  '/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion/Lc/BorelCaratheodory.lean',
  '/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion/Lc/ArgumentPrinciple.lean',
];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n').length;
  const bytes = Buffer.byteLength(src, 'utf8');
  // Warm up
  parser.parse(src);
  // Cold + 5 reps
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const t0 = process.hrtime.bigint();
    const tree = parser.parse(src);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);  // ms
    if (i === 0) {
      // Count nodes
      let n = 0;
      tree.cursor().iterate(() => { n++; });
      // eslint-disable-next-line no-console
      console.log(`${file.split('/').slice(-2).join('/')}: ${lines} lines, ${(bytes/1024).toFixed(0)}KB, ${n} nodes`);
    }
  }
  const median = samples.sort((a,b)=>a-b)[Math.floor(samples.length/2)];
  console.log(`  parse median: ${median.toFixed(1)}ms, samples: ${samples.map(s => s.toFixed(0)).join(', ')}`);
}
