#!/usr/bin/env node
// Inspect the Lezer grammar's top-level structure on a Lean file. For
// quickly verifying "did my grammar change actually produce the
// Declaration / NamespaceCmd / etc. wrapping I think it did."
//
// Usage:  node tree.mjs <input.lean>
//
// Prints top-level items with byte ranges + first 80 chars of each.
// Cap at 30 items to stay readable on big files.

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

const file = process.argv[2];
if (!file) { console.error('usage: node tree.mjs <input.lean>'); process.exit(1); }
const src = readFileSync(file, 'utf8');
const tree = parser.parse(src);

const cursor = tree.cursor();
cursor.firstChild();
let i = 0;
do {
  if (i++ > 30) { console.log('... (truncated at 30 items)'); break; }
  const text = src.slice(cursor.from, Math.min(cursor.to, cursor.from + 80)).replace(/\n/g, '\\n');
  console.log(`[${cursor.from}-${cursor.to}] ${cursor.name}: ${text}`);
} while (cursor.nextSibling());
