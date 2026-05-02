# Lean 4.27 grammar reference (extracted from vendored source)

Snapshot extracted on 2026-05-02 from `vendor/lean4-src/` at v4.27.0.
This is a cross-linked digest, not a formal spec — verify any specific claim
against the cited source files. Lean's grammar is defined in Lean via the
parser DSL; the source is authoritative.

All paths below are relative to `vendor/lean4-src/src/`.

---

## 1. Reserved keywords

Approximately 80+ reserved tokens. Group breakdown:

**Control flow:** `if`, `then`, `else`, `match`, `with`, `fun`, `λ`, `do`,
`return`, `let`, `have`, `for`, `in`, `unless`, `try`, `catch`, `by`, `calc`,
`show`, `suffices`, `dbg_trace`, `assert!`, `debug_assert!`, `nomatch`,
`nofun`, `sorry`.

**Declarations:** `def`, `theorem`, `lemma`, `example`, `instance`, `class`,
`structure`, `inductive`, `coinductive`, `abbrev`, `axiom`, `opaque`,
`mutual`, `where`.

**Modifiers:** `private`, `public`, `protected`, `noncomputable`, `unsafe`,
`partial`, `nonrec`, `meta`, `mut`.

**Namespacing:** `namespace`, `section`, `end`, `open`, `export`, `variable`,
`include`, `omit`, `universe`.

**Notation/syntax:** `notation`, `infix`, `infixl`, `infixr`, `prefix`,
`postfix`, `syntax`, `macro`, `macro_rules`, `elab`, `elab_rules`,
`attribute`, `set_option`, `initialize`.

**Hash commands:** `#check`, `#eval`, `#eval!`, `#synth`, `#print`,
`#print sig`, `#print axioms`, `#print equations`, `#print tactic tags`,
`#where`, `#exit`.

**Other:** `import`, `deriving`, `with_weak_namespace`, `_`, `@`.

Canonical: `Lean/Parser/Command.lean` lines 67–96 (modifiers), 184–335
(declarations).

---

## 2. Top-level commands

All defined in `Lean/Parser/Command.lean`. Tagged with `@[builtin_command_parser]`.

| Command | Shape | Source line |
|---------|-------|-------------|
| `declaration` | `declModifiers (abbrev\|def\|theorem\|opaque\|instance\|axiom\|example\|inductive\|coinductive\|structure\|class)` | 279 |
| `namespace <id>` | `namespace ident` | 314 |
| `section [<id>]` | `section optional(ident)` | 296 |
| `end [<id>]` | `end optional(ident)` | 334 |
| `variable (x : T)` | `variable many1(binder)` | 467 |
| `open ...` | `open openDecl` | 785 |
| `export <ns> (names)` | `export ident ( many1(ident) )` | 653 |
| `import <module>` | parsed by module system | 655 |
| `set_option <id> <value>` | `set_option ident value` | 621 |
| `attribute [...] <name>` | `attribute [ sepBy1(attr) ] many1(ident)` | 625 |
| `universe u v ...` | `universe many1(ident)` | 527 |
| `#check`, `#eval`, `#eval!`, `#synth` | `#cmd termParser` | 529–561 |
| `#print` | `#print (ident\|strLit)` | 565 |
| `#where`, `#exit` | nullary | 583, 563 |
| `mutual ... end` | `mutual` ... declarations ... `end` | 788 |
| `deriving instance ... for ...` | full syntax | 283 |

Module-level doc comment (`/-! ... -/`) is itself a top-level command node:
Command.lean:58–60.

---

## 3. Comment forms

Source: `Lean/Parser/Basic.lean` lines 537–587.

- **Line comments**: `--` followed by any text until end-of-line. Pattern:
  `--[^\n]*`. Consumed by the `whitespace` parser (line 576).
- **Block comments**: `/-` ... `-/`, **nestable**. Handled by
  `finishCommentBlock` (line 537) which tracks nesting depth: `/-` increments,
  `-/` decrements; only exits at depth 0.
- **Module doc**: `/-! ... -/`. Recognized in `whitespace` (line 584) but
  **not consumed** — emerges as a `moduleDoc` syntax node.
- **Declaration doc**: `/-- ... -/`. Same: emitted as a `docComment` syntax
  node attached to the next declaration. Term.lean:91. Can contain Verso
  markup if `doc.verso` option is true.

**Important for the Lezer grammar**: doc comments are *not* whitespace; they
are tokens that begin parser nodes. Block-comment nesting needs a state
counter in the tokenizer.

---

## 4. Token literals (operators / punctuation)

Fixed-syntax tokens (NOT user-extensible notation):

- Definition / arrow / mapsto: `:=`, `=>`, `↦`, `|>`, `→`, `->`, `←`, `<-`
- Range / variadic: `..`, `...`
- Punctuation: `:`, `;`, `,`, `|`, `(`, `)`, `[`, `]`, `{`, `}`
- Anonymous constructor: `⟨`, `⟩`
- Strict implicit: `⦃`, `⦄`
- Misc: `_` (hole), `@` (explicit arg), `#` (command prefix), `.`
  (projection), `` ` `` (name quoting)
- Identifier escape: `«` (U+00AB) ... `»` (U+00BB) — Init/Meta/Defs.lean:138–141

Locations: Basic.lean (1824, 1862), Term/Basic.lean (181, 215–216, 258),
Do.lean (23, 66), Command.lean (64, 236, 277).

---

## 5. Indent-sensitive contexts

Lean uses **column-tracking primitives**, not lexical indent/dedent tokens.
Source: `Lean/Parser/Basic.lean` lines 1466–1565.

Primitives:
- `checkColEq` (1480) — same column as `withPosition`
- `checkColGe` (1499) — ≥ column (allows deeper indent)
- `checkColGt` (1524) — strictly deeper
- `checkLineEq` (1542) — same line (composite tokens)
- `withPosition(p)` (1558) — saves current col/line for later checks

Affected constructs:
- `by` blocks — all tactics align (checkColEq)
- `do` blocks — continuation requires checkColGt (Do.lean:28–30)
- `match` arms — `| pat => ...` indentation checked
- `where` clauses — definitions must be indented
- `if/then/else` — `else` aligns with `if` (Command.lean:1495)
- Tactic sequences — subsequent tactics strictly indented (Term/Basic.lean:91)

Position is read from `ParserContext.savedPos?`, checked against
`FileMap.toPosition`. Python-style significant whitespace via column
tracking.

For a coarse Lezer grammar, the practical implication: top-level commands
all start at column 0 (or close to it) — that's a reliable boundary
marker for body absorption, even if we don't try to parse interior
indentation.

---

## 6. Identifier and literal rules

### Identifiers

Source: `Init/Meta/Defs.lean` lines 119–141.

- **Start char**: `isIdFirst c` = `c.isAlpha ∨ c = '_' ∨ isLetterLike c`
  → ASCII `[a-zA-Z_]` plus Unicode letters/letter-likes
- **Continuation**: `isIdRest c` = `c.isAlphanum ∨ c = '_' ∨ c = '\'' ∨
  c = '!' ∨ c = '?' ∨ isLetterLike c ∨ isSubScriptAlnum c`
  → ASCII `[a-zA-Z0-9_'!?]` plus Unicode + subscript numerals
- **Escape**: `«…»` allows any characters between U+00AB / U+00BB

### Numeric literals

Source: `Lean/Parser/Basic.lean` lines 704–930.

| Form | Pattern |
|------|---------|
| Decimal | `[0-9]+` |
| Hex | `0x[0-9a-fA-F]+` |
| Binary | `0b[01]+` |
| Octal | `0o[0-7]+` |
| Float | `[0-9]+\.[0-9]+` |
| Scientific | `[0-9]+(\.[0-9]+)?[eE][+-]?[0-9]+` |

Function: `numberFnAux` (831+); `scientificLitFn` (850).

### String / char / name literals

- **String**: `"..."` with `\n`, `\t`, `\\`, `\"` etc. Function `strLitFnAux` (719).
- **Raw string**: `r"..."` (1038).
- **Interpolation**: `s!"x={x}"` — custom parser.
- **Char**: `'c'` with escapes. Function `charLitFnAux` (704).
- **Name literal**: `` `foo.bar.baz `` — backtick prefix; can have dots.
  Function `nameLitAux` (1015).

Top-level dispatcher: `tokenFnAux` (1027).

---

## 7. Surprising / unusual features

### Antiquotation syntax (metaprogramming)

`$id`, `$_`, `$(expr)`, `%$id`. Used in syntax/term/tactic quotations.
Functions: `antiquotExpr` (Basic.lean:1775), `antiquotNestedExpr` (1774).
Token kinds: `token_antiquot`, `antiquot_scope`, `antiquot_suffix_splice`.

### Pratt-style `leading_parser` vs `trailing_parser`

Pratt parsing convention. Leading = prefix operators / literals / keywords;
trailing = postfix/infix continuations. Wrapped in named syntax nodes via
`leadingNode` / `trailingNode`. Implementation: Basic.lean:1923.

### Hygienic macros

Lean's macros are hygiene-respecting by default; gensym ensures fresh names
to avoid capture. Parser has special antiquotation handling (1835–1842).

### Category-based parsing

Grammar is extensible via `syntax` declarations registered in named
categories: `term`, `command`, `tactic`, `doElem`, `stx`, `prec`, `attr`,
`conv`. Selection via `categoryParser` (Basic.lean builtin) with precedence.

### No separate lexer

Whitespace is tracked in-place. `symbol` vs `symbolNoWs` controls whether
whitespace is required. Pretty-printing hints (`ppSpace`, `ppLine`,
`ppDedent`) don't affect parsing. `checkLineEq` ensures composite tokens
don't span lines.

### Unicode

Identifiers fully Unicode. Many operators have Unicode aliases:
`→`/`->`, `←`/`<-`, `λ`/`fun`. Subscript/superscript numerals recognized in
identifier continuation.

### `withForbidden`

`withForbidden "do" term` parses term but rejects `do` at top level.
Disambiguates `for x in t do ...` vs `for x in (t do ...)`. Do.lean:44.

---

## File index

| Topic | Source path |
|-------|-------------|
| Keywords / modifiers | `Lean/Parser/Command.lean:67–96` |
| Command definitions | `Lean/Parser/Command.lean:58–941` |
| Comments | `Lean/Parser/Basic.lean:537–587` |
| Column / indent | `Lean/Parser/Basic.lean:1466–1565` |
| Token dispatcher | `Lean/Parser/Basic.lean:1027–1083` |
| Identifier classes | `Init/Meta/Defs.lean:119–141` |
| Numeric literals | `Lean/Parser/Basic.lean:704–930` |
| Antiquotations | `Lean/Parser/Basic.lean:1773–1872` |
| Term syntax | `Lean/Parser/Term.lean` |
| Do-notation | `Lean/Parser/Do.lean` |
| Syntax / macro | `Lean/Parser/Syntax.lean` |
