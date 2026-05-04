import { LRLanguage, LanguageSupport } from '@codemirror/language';
import { styleTags, tags as t } from '@lezer/highlight';
import { parser } from './lean.grammar';

/**
 * Coarse Lezer-based language support for Lean 4 (Phase 3d).
 *
 * styleTags maps grammar node names → @lezer/highlight tags. CM6's
 * syntaxHighlighting extension consumes these to apply CSS classes from
 * the active HighlightStyle (defaultHighlightStyle gives sensible
 * VS-light colors). Custom theming is a separate concern.
 *
 * Node names from kw<term> / hashCmd<term> are the literal term text
 * (per `@specialize[@name={term}]`), e.g. `def`, `if`, `#check`.
 */
const leanLR = LRLanguage.define({
  parser: parser.configure({
    props: [
      styleTags({
        // Declaration keywords
        'def theorem lemma example instance class structure inductive coinductive abbrev axiom opaque mutual':
          t.definitionKeyword,
        // Modifier keywords
        'private public protected noncomputable unsafe partial nonrec meta':
          t.modifier,
        // Namespace / module structure keywords
        'namespace section end open export variable include omit universe import deriving':
          t.moduleKeyword,
        // Control flow
        'if then else match with fun do return let have for in unless try catch by calc show suffices where sorry':
          t.controlKeyword,
        // Notation declaration
        'notation infix infixl infixr prefix postfix':
          t.keyword,
        // Macro / syntax / attribute machinery
        'syntax macro macro_rules elab elab_rules attribute set_option initialize':
          t.meta,
        // Hash commands (#check, #eval, ...) — quoted because node names
        // start with '#'.
        '"#check" "#eval" "#eval!" "#synth" "#print" "#where" "#exit" "#reduce" "#find"':
          t.special(t.keyword),

        // Tokens
        Identifier: t.variableName,
        HashIdent: t.special(t.keyword),
        Number: t.number,
        StringLit: t.string,
        CharLit: t.character,
        Operator: t.operator,
        Punct: t.punctuation,
        SinglePunct: t.punctuation,
        LineComment: t.lineComment,
        BlockComment: t.blockComment,
        DocBlockComment: t.docComment,
        ModuleDocComment: t.docComment,
      }),
    ],
  }),
  languageData: {
    commentTokens: { line: '--', block: { open: '/-', close: '-/' } },
  },
});

export function leanLanguage(): LanguageSupport {
  return new LanguageSupport(leanLR);
}
