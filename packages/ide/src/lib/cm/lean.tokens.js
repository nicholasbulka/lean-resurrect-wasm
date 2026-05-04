// External tokenizer for Lean 4 nested block comments. The regex-only
// approach in Phase 3b couldn't handle nesting; in real Mathlib doc
// comments, /-- ... /- inner -/ ... -/ nesting is common. We track depth
// here, in JS, where we have the state machine needed.
//
// Reference: vendor/lean4-src/src/Lean/Parser/Basic.lean:537
// (finishCommentBlock — uses a depth counter for /-...-/ nesting).

import { ExternalTokenizer } from '@lezer/lr';
import {
  BlockComment,
  DocBlockComment,
  ModuleDocComment,
} from './lean.grammar.terms';

const SLASH = 47;
const DASH = 45;
const BANG = 33;

export const blockComment = new ExternalTokenizer((input) => {
  if (input.next !== SLASH) return;
  if (input.peek(1) !== DASH) return;

  // Determine flavour (block / doc-block / module-doc) from chars 2..3.
  let token;
  let prefixLen;
  const after = input.peek(2);
  if (after === BANG) {
    token = ModuleDocComment;
    prefixLen = 3; // /-!
  } else if (after === DASH) {
    token = DocBlockComment;
    prefixLen = 3; // /--
  } else {
    token = BlockComment;
    prefixLen = 2; // /-
  }

  for (let i = 0; i < prefixLen; i++) input.advance();

  // Scan to matching -/ tracking nesting. Lean's `finishCommentBlock` does
  // exactly this on the C++ side.
  let depth = 1;
  while (depth > 0 && input.next >= 0) {
    if (input.next === SLASH && input.peek(1) === DASH) {
      depth++;
      input.advance();
      input.advance();
    } else if (input.next === DASH && input.peek(1) === SLASH) {
      depth--;
      input.advance();
      input.advance();
    } else {
      input.advance();
    }
  }

  input.acceptToken(token);
});
