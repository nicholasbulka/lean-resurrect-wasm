#!/usr/bin/env node
// Print specific disagreement regions (byte ranges where Lean and Lezer
// disagree) with surrounding context. Useful for diagnosing what's
// driving a low accuracy score on a specific file.
//
// Usage:  node disagreements.mjs <input.lean> [--limit N]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildParser } from '../../packages/ide/node_modules/@lezer/generator/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const GRAMMAR_PATH = join(REPO_ROOT, 'packages/ide/src/lib/cm/lean.grammar');
const LEAN_DUMP = join(__dirname, 'dump-tokens.lean');

const filePath = process.argv[2];
const limit = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--limit') ?? '8');
if (!filePath) { console.error('usage: node disagreements.mjs <input.lean> [--limit N]'); process.exit(1); }

const grammarSrc = readFileSync(GRAMMAR_PATH, 'utf8');
const parser = buildParser(grammarSrc);

const LEAN_KEYWORDS = new Set([
  'def', 'theorem', 'lemma', 'example', 'instance', 'class', 'structure',
  'inductive', 'coinductive', 'abbrev', 'axiom', 'opaque', 'mutual',
  'private', 'public', 'protected', 'noncomputable', 'unsafe', 'partial',
  'nonrec', 'meta', 'namespace', 'section', 'end', 'open', 'export',
  'variable', 'include', 'omit', 'universe', 'import', 'deriving',
  'if', 'then', 'else', 'match', 'with', 'fun', 'do', 'return', 'let',
  'have', 'for', 'in', 'unless', 'try', 'catch', 'by', 'calc', 'show',
  'suffices', 'where', 'sorry', 'notation', 'infix', 'infixl', 'infixr',
  'prefix', 'postfix', 'syntax', 'macro', 'macro_rules', 'elab',
  'elab_rules', 'attribute', 'set_option', 'initialize',
  '#check', '#eval', '#eval!', '#synth', '#print', '#where', '#exit',
  '#reduce', '#find',
]);

function normalizeLean(kind, text) {
  if (kind === 'ident') return 'ident';
  if (kind === 'atom') {
    if (LEAN_KEYWORDS.has(text)) return 'keyword';
    if (text.startsWith('/-') || text === '-/') return 'comment';
    if (text.endsWith('-/') && (text.length > 4 || text.includes('\n'))) return 'comment';
    if (/^[0-9]/.test(text)) return 'number';
    if (text.startsWith('"')) return 'string';
    if (text.startsWith("'") && text.length >= 3) return 'char';
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text)) return 'ident';
    return 'punct';
  }
  return 'other';
}

function normalizeLezer(name) {
  if (LEAN_KEYWORDS.has(name)) return 'keyword';
  switch (name) {
    case 'Identifier': return 'ident';
    case 'HashIdent': return 'keyword';
    case 'Number': return 'number';
    case 'StringLit': return 'string';
    case 'CharLit': return 'char';
    case 'LineComment':
    case 'BlockComment':
    case 'DocBlockComment':
    case 'ModuleDocComment':
      return 'comment';
    case 'Operator':
    case 'Punct':
      return 'punct';
    case 'Other': return 'other';
    default: return null;
  }
}

const r = spawnSync('lean', ['--run', LEAN_DUMP, filePath], { encoding: 'utf8' });
const leanTokens = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));

const src = readFileSync(filePath);
const totalBytes = src.length;
const text = src.toString('utf8');

const tree = parser.parse(text);
const lezerTokens = [];
tree.cursor().iterate(node => {
  const cat = normalizeLezer(node.name);
  if (cat === null) return true;
  lezerTokens.push({ from: node.from, to: node.to, kind: node.name, cat });
  return false;
});

const charToByte = new Array(text.length + 1);
let b = 0;
for (let i = 0; i < text.length; i++) {
  charToByte[i] = b;
  const code = text.codePointAt(i);
  if (code <= 0x7f) b += 1;
  else if (code <= 0x7ff) b += 2;
  else if (code <= 0xffff) b += 3;
  else { b += 4; i++; }
}
charToByte[text.length] = b;

function fillBytes(arr, from, to, val) {
  for (let i = from; i < to; i++) arr[i] = val;
}
const leanArr = new Array(totalBytes).fill('-');
const lezerArr = new Array(totalBytes).fill('-');
for (const t of leanTokens) fillBytes(leanArr, t.from, t.to, normalizeLean(t.kind, t.text));
for (const t of lezerTokens) fillBytes(lezerArr, charToByte[t.from] ?? 0, charToByte[t.to] ?? totalBytes, t.cat);

// Coalesce adjacent disagreeing bytes into ranges.
const disagreements = [];
let i = 0;
while (i < totalBytes) {
  const l = leanArr[i], z = lezerArr[i];
  if (l !== '-' && l !== z) {
    let j = i;
    while (j < totalBytes && leanArr[j] === l && lezerArr[j] === z) j++;
    disagreements.push({ from: i, to: j, lean: l, lezer: z });
    i = j;
  } else {
    i++;
  }
}

disagreements.sort((a, b) => (b.to - b.from) - (a.to - a.from));
console.log(`Total disagreements: ${disagreements.length}`);
for (const d of disagreements.slice(0, limit)) {
  const snippetStart = Math.max(0, d.from - 20);
  const snippetEnd = Math.min(totalBytes, d.to + 20);
  const before = src.slice(snippetStart, d.from).toString('utf8');
  const middle = src.slice(d.from, d.to).toString('utf8');
  const after = src.slice(d.to, snippetEnd).toString('utf8');
  const line = src.slice(0, d.from).toString('utf8').split('\n').length;
  console.log(`[bytes ${d.from}-${d.to} | line ~${line} | lean=${d.lean} lezer=${d.lezer} | len=${d.to - d.from}]`);
  console.log(`  ...${before.replace(/\n/g, '\\n')}«${middle.replace(/\n/g, '\\n')}»${after.replace(/\n/g, '\\n')}...`);
}
