import { LRLanguage, LanguageSupport } from '@codemirror/language';
import { parser } from './lean.grammar';

/**
 * Coarse Lezer-based language support for Lean 4. Phase 3a: minimal grammar
 * (just identifiers/numbers/other tokens) — enough to confirm the Lezer
 * pipeline compiles and CM6 accepts the parser. Real grammar lands in 3b+.
 */
const leanLR = LRLanguage.define({
  parser,
  languageData: {
    commentTokens: { line: '--', block: { open: '/-', close: '-/' } },
  },
});

export function leanLanguage(): LanguageSupport {
  return new LanguageSupport(leanLR);
}
