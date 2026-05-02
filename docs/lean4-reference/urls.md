# Lean 4 prose documentation URLs

The reference manual and learning books document what constructs *mean*. For
grammar work, the snapshot in `grammar-reference-v4.27.md` is more useful;
these are for understanding semantics.

These are URLs, not vendored copies. Snapshotting prose docs adds maintenance
burden and they go stale anyway. Read them in a browser when needed.

## Reference manual (canonical)

- **Lean 4 Manual** — https://lean-lang.org/lean4/doc/
  - Whatsnew / version notes — useful when bumping toolchain versions
  - Lexical syntax — comments, identifiers, numerals, string escapes
  - Declarations — `def`, `theorem`, structures, classes, inductives
  - Tactics — built-in tactic reference
  - Notation — `notation`, `infix*`, `prefix`, `postfix` declarations
  - Macros — `syntax`, `macro`, `macro_rules`, `elab`
  - Attributes — `@[simp]`, `@[builtin_command_parser]`, etc.
  - Module system — `import`, namespaces, `open`/`export`

The manual is updated against current Lean; for v4.27-specific behavior,
cross-check against the vendored source if anything looks off.

## Learning books

- **Theorem Proving in Lean 4** — https://lean-lang.org/theorem_proving_in_lean4/
  - Chapter 1–3: dependent types, propositions as types
  - Chapter 4: quantifiers and equality
  - Chapter 5: tactics
  - Chapter 6: interacting with Lean
  - Chapter 7: inductive types
  - Chapter 8: induction and recursion
  - Chapter 11–13: structures, type classes, the simplifier
  - Best for understanding what Lean *does* with constructs the grammar parses.

- **Functional Programming in Lean** —
  https://lean-lang.org/functional_programming_in_lean/
  - Programming-side reference. Type classes, monads, do-notation, IO.
  - Useful for understanding `do`-block syntax and effect machinery.

## Mathlib

- **Mathlib4 docs** — https://leanprover-community.github.io/mathlib4_docs/
  - Reference for Mathlib's notation, conventions, naming.
  - Useful when investigating LiCriterion's imports.

- **Mathlib4 source** — https://github.com/leanprover-community/mathlib4
  - When prose docs aren't enough, read the source.

## Parser-internals reading

When the grammar reference snapshot is incomplete, these are the actual
files to read in `vendor/lean4-src/src/`:

- `Lean/Parser/Basic.lean` — token functions, comment lexer, column
  tracking, antiquotations, the lot
- `Lean/Parser/Command.lean` — top-level commands
- `Lean/Parser/Term.lean` — expression syntax
- `Lean/Parser/Tactic.lean` — tactic syntax
- `Lean/Parser/Do.lean` — do-notation (heavily indent-sensitive)
- `Lean/Parser/Syntax.lean` — `syntax`/`macro_rules` declarations
- `Init/Meta/Defs.lean` — character classes, identifier rules

## What to skip

- Tutorials and "Hello world" Lean material — not relevant for IDE/grammar work.
- LSP protocol docs — relevant later for the on-demand LSP client; defer.
- Lake build system docs — relevant for the BYOML feature; the lakefile.lean
  in LiCriterion is itself a Lean file that exercises the Lake DSL syntax.
