import type { Monaco } from '@monaco-editor/react';

/**
 * Register a minimal Lean 4 language: keywords, comments, strings, numbers,
 * tactics, operators, attributes. Not a full Lean parser — a Monaco tokenizer
 * needs only enough to color tokens plausibly. Good enough for reading and
 * keeping typos visible.
 */
export function registerLeanLanguage(monaco: Monaco) {
  if (monaco.languages.getLanguages().some((l) => l.id === 'lean4')) return;

  monaco.languages.register({ id: 'lean4', extensions: ['.lean'] });

  monaco.languages.setLanguageConfiguration('lean4', {
    comments: { lineComment: '--', blockComment: ['/-', '-/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
      ['⟨', '⟩'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '⟨', close: '⟩' },
    ],
  });

  monaco.languages.setMonarchTokensProvider('lean4', {
    defaultToken: '',
    tokenPostfix: '.lean',

    keywords: [
      'import', 'export', 'open', 'namespace', 'end', 'section', 'universe', 'universes',
      'def', 'theorem', 'lemma', 'example', 'instance', 'class', 'structure', 'inductive', 'coinductive',
      'variable', 'variables', 'constant', 'constants', 'axiom', 'axioms', 'abbrev', 'notation',
      'infix', 'infixl', 'infixr', 'prefix', 'postfix',
      'if', 'then', 'else', 'match', 'with', 'fun', 'λ', 'let', 'have', 'show', 'from',
      'do', 'return', 'for', 'in', 'where', 'by', 'sorry', 'calc',
      'protected', 'private', 'public', 'mutual', 'deriving', 'extends',
      'attribute', 'macro', 'macro_rules', 'syntax', 'elab', 'meta',
    ],

    tactics: [
      'intro', 'intros', 'apply', 'exact', 'refine', 'rfl', 'simp', 'simp_all', 'simp_arith',
      'rewrite', 'rw', 'subst', 'split', 'cases', 'induction', 'contradiction',
      'constructor', 'assumption', 'trivial', 'decide', 'ring', 'linarith', 'nlinarith', 'omega',
      'left', 'right', 'use', 'exists', 'unfold', 'change',
      'have', 'suffices', 'show', 'clear', 'rename', 'rename_i', 'revert', 'generalize',
      'first', 'repeat', 'try', 'focus', 'skip', 'done', 'admit',
    ],

    commands: ['#check', '#eval', '#print', '#reduce', '#find', '#help'],

    typeKeywords: [
      'Prop', 'Type', 'Sort', 'Nat', 'Int', 'Real', 'Float', 'Bool', 'String', 'Char',
      'List', 'Array', 'Option', 'Sum', 'Prod', 'Unit', 'Empty',
    ],

    operators: [
      ':=', '=>', '↦', '→', '←', '↑', '↓', '∧', '∨', '¬', '∀', '∃', '∘', '⊢',
      '=', '≠', '≤', '≥', '<', '>', '+', '-', '*', '/', '%', '^', ':', '|', '∈', '∉', '⊆', '⊇',
      '·', '..', '...',
    ],

    symbols: /[=><!~?:&|+\-*/^%↦→←↑↓∧∨¬∀∃∘⊢≠≤≥∈∉⊆⊇·]+/,

    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4})/,

    tokenizer: {
      root: [
        // Documentation / attribute blocks before identifiers.
        [/#[a-z_]+/, { cases: { '@commands': 'keyword.control', '@default': 'identifier' } }],
        [/@\[[^\]]*\]/, 'annotation'],

        // Identifiers, keywords, tactics.
        [/[A-Z][\w']*/, { cases: { '@typeKeywords': 'type', '@default': 'type.identifier' } }],
        [/[a-z_][\w']*!?/, {
          cases: {
            '@keywords': 'keyword',
            '@tactics': 'keyword.flow',
            '@typeKeywords': 'type',
            '@default': 'identifier',
          },
        }],

        // Block comments (nestable in Lean — we approximate).
        [/\/-/, 'comment', '@blockComment'],
        // Line comments.
        [/--.*$/, 'comment'],

        // Strings.
        [/"([^"\\]|\\.)*"/, 'string'],
        [/"/, 'string', '@string'],

        // Char literals.
        [/'(?:[^'\\]|\\.)'/, 'string.char'],

        // Numbers (int, float, hex, binary).
        [/0x[0-9A-Fa-f]+/, 'number.hex'],
        [/0b[01]+/, 'number.binary'],
        [/\d+\.\d+([eE][+-]?\d+)?/, 'number.float'],
        [/\d+/, 'number'],

        // Delimiters + operators.
        [/[{}()[\]⟨⟩]/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],

        // Whitespace.
        [/\s+/, 'white'],
      ],

      blockComment: [
        [/[^/-]+/, 'comment'],
        [/-\//, 'comment', '@pop'],
        [/\/-/, 'comment', '@push'],
        [/./, 'comment'],
      ],

      string: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/"/, 'string', '@pop'],
      ],
    },
  } as any);
}
