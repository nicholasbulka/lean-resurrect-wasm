import { LRLanguage, LanguageSupport, foldNodeProp } from '@codemirror/language';
import { styleTags, tags as t } from '@lezer/highlight';
import { parser } from './lean.grammar';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

// Fold from end of the first line of a node to the end of the node. The
// keyword + identifier on line 1 stay visible; the body collapses behind
// it. Returns null for single-line nodes (no useful fold).
function foldAfterFirstLine(node: SyntaxNode, state: EditorState) {
  const firstLineEnd = state.doc.lineAt(node.from).to;
  if (firstLineEnd >= node.to - 1) return null;
  return { from: firstLineEnd, to: node.to };
}

// For a /- ... -/ block comment, fold the inside (between the /- and -/).
function foldCommentInside(node: SyntaxNode, _state: EditorState) {
  // node spans /- ... -/. Inner range is +2 from start (skip /-, /-!, /--)
  // to -2 from end (skip -/). For doc-comments the prefix is 3 chars but
  // folding 2 in is harmless — the extra dash stays as a hint.
  const inner = { from: node.from + 2, to: node.to - 2 };
  if (inner.to - inner.from < 5) return null;
  return inner;
}

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
      foldNodeProp.add({
        Declaration: foldAfterFirstLine,
        NamespaceCmd: foldAfterFirstLine,
        NotationCmd: foldAfterFirstLine,
        MetaCmd: foldAfterFirstLine,
        HashCmd: foldAfterFirstLine,
        BlockComment: foldCommentInside,
        DocBlockComment: foldCommentInside,
        ModuleDocComment: foldCommentInside,
      }),
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

// === Outline ===
// Extract a flat list of top-level declarations / commands from the
// parsed tree. Mirrors what an LSP documentSymbol response would carry,
// but local — no server round-trip. Future features (sidebar outline,
// jump-to-definition fallback, structural navigation) consume this.

export interface OutlineEntry {
  /** Lean keyword that starts the item: "def", "theorem", "namespace", "import", "#check", etc. */
  kind: string;
  /** First identifier following the keyword, if present (the declared name). */
  name: string | null;
  /** Byte range covering the whole item (Declaration / NamespaceCmd / etc.). */
  from: number;
  to: number;
  /** Byte range of the keyword itself (for highlighting / cursor jumps). */
  keywordFrom: number;
  keywordTo: number;
  /** Byte range of the identifier, if any. */
  nameFrom: number | null;
  nameTo: number | null;
}

const TOP_LEVEL_KINDS = new Set([
  'Declaration', 'NamespaceCmd', 'NotationCmd', 'MetaCmd', 'HashCmd',
]);

interface TreeLike {
  topNode: SyntaxNode;
}

export function extractOutline(tree: TreeLike, doc: { sliceString(from: number, to: number): string }): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let child = tree.topNode.firstChild;
  while (child) {
    if (TOP_LEVEL_KINDS.has(child.name)) {
      let kw: SyntaxNode | null = child.firstChild;
      // Skip modifiers (e.g., private/public) to find the actual keyword.
      while (kw && kw.name === 'modifierKeyword') kw = kw.nextSibling;
      // declarationKeyword / namespaceKeyword / etc. wrap a kw<term> node;
      // the actual keyword text node is one level down.
      const kwInner = kw?.firstChild ?? kw;
      const kwName = kwInner ? doc.sliceString(kwInner.from, kwInner.to) : '';

      // First Identifier after the keyword wrapper is the declared name.
      let nameNode: SyntaxNode | null = null;
      let scan = kw?.nextSibling ?? null;
      while (scan) {
        if (scan.name === 'Identifier') { nameNode = scan; break; }
        scan = scan.nextSibling;
      }

      out.push({
        kind: kwName,
        name: nameNode ? doc.sliceString(nameNode.from, nameNode.to) : null,
        from: child.from,
        to: child.to,
        keywordFrom: kwInner?.from ?? child.from,
        keywordTo: kwInner?.to ?? child.from,
        nameFrom: nameNode?.from ?? null,
        nameTo: nameNode?.to ?? null,
      });
    }
    child = child.nextSibling;
  }
  return out;
}
