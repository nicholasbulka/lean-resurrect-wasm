#!/usr/bin/env node
// Compare our Lezer grammar's tokenization to Lean's own parser output.
//
// Usage:  node diff.mjs <input.lean>
//
// 1. Runs `lean --run dump-tokens.lean <input>` to get Lean's tokens.
// 2. Builds our Lezer parser from packages/ide/src/lib/cm/lean.grammar.
// 3. Parses the same input via the Lezer parser, walks the tree, classifies.
// 4. Computes per-byte agreement on a normalized 'category' vocabulary.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve from packages/ide's node_modules — no separate install needed.
import { buildParser } from '../../packages/ide/node_modules/@lezer/generator/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const GRAMMAR_PATH = join(REPO_ROOT, 'packages/ide/src/lib/cm/lean.grammar');
const LEAN_DUMP = join(__dirname, 'dump-tokens.lean');

// === Lezer setup ===

const grammarSrc = readFileSync(GRAMMAR_PATH, 'utf8');
const parser = buildParser(grammarSrc);

// === Categories: a small shared vocabulary across both sides ===

// Categories. PUNCT covers both operators and punctuation — Lean's parser
// treats them all as `atom` and its own LSP semanticTokens collapses them
// into a single `operator`/`punctuation` family for highlighting. We follow
// suit; finer distinctions belong in styleTags later, not in accuracy
// scoring.
const CAT = {
  KEYWORD: 'keyword',
  IDENT: 'ident',
  NUMBER: 'number',
  STRING: 'string',
  CHAR: 'char',
  COMMENT: 'comment',
  PUNCT: 'punct',
  OTHER: 'other',
  UNCOVERED: '-',
};

// Lean's parser emits two leaf kinds: "atom" and "ident". Atoms with text
// matching a known reserved keyword get categorized as KEYWORD. Otherwise
// atoms are operators or punctuation depending on their characters.
const LEAN_KEYWORDS = new Set([
  'def', 'theorem', 'lemma', 'example', 'instance', 'class', 'structure',
  'inductive', 'coinductive', 'abbrev', 'axiom', 'opaque', 'mutual',
  'private', 'public', 'protected', 'noncomputable', 'unsafe', 'partial',
  'nonrec', 'meta',
  'namespace', 'section', 'end', 'open', 'export', 'variable', 'include',
  'omit', 'universe', 'import', 'deriving',
  'if', 'then', 'else', 'match', 'with', 'fun', 'do', 'return', 'let',
  'have', 'for', 'in', 'unless', 'try', 'catch', 'by', 'calc', 'show',
  'suffices', 'where', 'sorry',
  'notation', 'infix', 'infixl', 'infixr', 'prefix', 'postfix',
  'syntax', 'macro', 'macro_rules', 'elab', 'elab_rules', 'attribute',
  'set_option', 'initialize',
  '#check', '#eval', '#eval!', '#synth', '#print', '#where', '#exit',
  '#reduce', '#find',
]);

function normalizeLean(kind, text) {
  if (kind === 'ident') return CAT.IDENT;
  if (kind === 'atom') {
    if (LEAN_KEYWORDS.has(text)) return CAT.KEYWORD;
    // Lean's parser splits doc-comments into "/-!"/"/--" + body atom;
    // both belong in the comment bucket. Recognize either form: starts
    // with /-, or is a closing "-/" only.
    if (text.startsWith('/-') || text === '-/') return CAT.COMMENT;
    // Body atoms of doc-comments end with "-/" and contain newlines /
    // long prose — treat as comment.
    if (text.endsWith('-/') && (text.length > 4 || text.includes('\n'))) return CAT.COMMENT;
    if (/^[0-9]/.test(text)) return CAT.NUMBER;
    if (text.startsWith('"')) return CAT.STRING;
    if (text.startsWith("'") && text.length >= 3) return CAT.CHAR;
    // Alphabetic atoms not in our keyword list are context-specific
    // sub-keywords (e.g. `axioms` in `#print axioms`, `sig` in
    // `#print sig`, `instance` in `deriving instance`). Tokenized as
    // identifiers by any non-Lean lexer; classify as ident for accuracy.
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text)) return CAT.IDENT;
    return CAT.PUNCT;
  }
  return CAT.OTHER;
}

// Lezer node-name → category. Specialized keywords have node names equal
// to the keyword text (per @specialize[@name={term}]).
const LEZER_KEYWORD_NAMES = LEAN_KEYWORDS;

function normalizeLezer(name) {
  if (!name) return CAT.OTHER;
  if (LEZER_KEYWORD_NAMES.has(name)) return CAT.KEYWORD;
  switch (name) {
    case 'Identifier': return CAT.IDENT;
    case 'HashIdent': return CAT.KEYWORD;  // unspecialized #cmds still keyword-like
    case 'Number': return CAT.NUMBER;
    case 'StringLit': return CAT.STRING;
    case 'CharLit': return CAT.CHAR;
    case 'LineComment':
    case 'BlockComment':
    case 'DocBlockComment':
    case 'ModuleDocComment':
      return CAT.COMMENT;
    case 'Operator':
    case 'Punct':
      return CAT.PUNCT;
    case 'Other': return CAT.OTHER;
    default: return null;  // wrapper nodes (declarationKeyword, etc.) — skip
  }
}

// === Read Lean's tokens ===

function dumpLean(filePath) {
  const r = spawnSync('lean', ['--run', LEAN_DUMP, filePath], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[lean] exit', r.status, r.stderr);
    process.exit(2);
  }
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// === Classify Lezer tree as a list of leaf tokens ===

function lezerLeafTokens(tree) {
  const tokens = [];
  tree.cursor().iterate(
    (node) => {
      const cat = normalizeLezer(node.name);
      if (cat === null) return true;  // descend into wrapper
      tokens.push({ from: node.from, to: node.to, kind: node.name, cat });
      return false;  // don't descend further
    },
  );
  return tokens;
}

// === Per-byte category arrays ===

function buildPerByte(tokens, totalBytes) {
  const arr = new Array(totalBytes).fill(CAT.UNCOVERED);
  for (const t of tokens) {
    const fr = Math.max(0, t.from);
    const to = Math.min(totalBytes, t.to);
    const cat = t.cat ?? t.normalized ?? CAT.OTHER;
    for (let i = fr; i < to; i++) arr[i] = cat;
  }
  return arr;
}

// === Main ===

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('usage: node diff.mjs <input.lean>');
    process.exit(1);
  }
  const src = readFileSync(filePath);  // Buffer (raw bytes, matches Lean's byteIdx)
  const totalBytes = src.length;

  const leanTokens = dumpLean(filePath).map((t) => ({
    from: t.from,
    to: t.to,
    kind: t.kind,
    cat: normalizeLean(t.kind, t.text),
  }));

  // Lezer parses the source as a string. Lean tokens are byte-indexed.
  // For ASCII-heavy Lean files the difference is small; for Unicode heavy
  // files we'll see misalignment we'll need to correct later.
  const tree = parser.parse(src.toString('utf8'));
  const lezerTokens = lezerLeafTokens(tree);

  // Per-character (UTF-16 code-unit) view for Lezer; Lean is bytes. To
  // compare apples to apples, convert Lezer ranges to byte offsets.
  const text = src.toString('utf8');
  const charToByte = new Array(text.length + 1);
  let b = 0;
  for (let i = 0; i < text.length; i++) {
    charToByte[i] = b;
    const code = text.codePointAt(i);
    if (code <= 0x7f) b += 1;
    else if (code <= 0x7ff) b += 2;
    else if (code <= 0xffff) b += 3;
    else { b += 4; i++; }  // surrogate pair
  }
  charToByte[text.length] = b;

  const lezerByteTokens = lezerTokens.map((t) => ({
    from: charToByte[t.from] ?? 0,
    to: charToByte[t.to] ?? totalBytes,
    cat: t.cat,
    kind: t.kind,
  }));

  const leanArr = buildPerByte(leanTokens, totalBytes);
  const lezerArr = buildPerByte(lezerByteTokens, totalBytes);

  // Score: byte agrees if both classify it as the same category, OR if
  // both leave it uncovered. Bytes Lean leaves uncovered (whitespace,
  // comments, parse failures) are skipped from the denominator if Lezer
  // covers them — Lean simply doesn't emit comments/whitespace and we
  // shouldn't penalize ourselves for that.
  let total = 0, agree = 0, leanCov = 0, lezerCov = 0;
  const confusion = new Map();  // 'leanCat>lezerCat' -> count
  for (let i = 0; i < totalBytes; i++) {
    const l = leanArr[i];
    const z = lezerArr[i];
    if (l !== CAT.UNCOVERED) leanCov++;
    if (z !== CAT.UNCOVERED) lezerCov++;
    if (l === CAT.UNCOVERED) continue;  // Lean didn't classify here
    total++;
    if (l === z) {
      agree++;
    } else {
      const key = `${l}→${z}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
  }

  console.log(JSON.stringify({
    file: filePath,
    bytes: totalBytes,
    leanCovBytes: leanCov,
    lezerCovBytes: lezerCov,
    leanCovPct: ((leanCov / totalBytes) * 100).toFixed(1),
    lezerCovPct: ((lezerCov / totalBytes) * 100).toFixed(1),
    leanScored: total,
    leanAgreed: agree,
    accuracyPct: total ? ((agree / total) * 100).toFixed(2) : 'N/A',
    confusion: Object.fromEntries([...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
  }, null, 2));
}

main();
