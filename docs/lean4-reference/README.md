# Lean 4.27 grammar reference

Curated reference for the IDE / Lezer-grammar work. Lean's grammar is defined
IN Lean itself via the `syntax` builtin and parser DSL — there is no formal
spec separate from the source. This directory points at the authoritative
artifacts and notes which files in the vendored source contain ground truth.

We are pinned to Lean 4.27.0 (see project memory). All references below are
relative to:

- `/Users/nicholasbulka/prog/lean/wasm/vendor/lean4-src/`

## Files in this directory

- `grammar-reference-v4.27.md` — structured snapshot extracted from the
  vendored source: keyword inventory, command syntax, comment rules,
  operators/punctuation, indent-sensitive contexts, identifier and numeric
  literal rules, antiquotation and category-based parsing notes. Cross-linked
  to source paths and line numbers so each claim can be verified against the
  actual parser.
- `urls.md` — pointers to the official prose documentation (reference manual,
  Theorem Proving in Lean 4, Functional Programming in Lean) with notes on
  which sections are useful for grammar work vs. semantics work.

## How to use this

1. Writing/extending the Lezer grammar: start with `grammar-reference-v4.27.md`,
   verify any specific claim by opening the cited source file (e.g.
   `vendor/lean4-src/src/Lean/Parser/Command.lean:279` for declaration syntax).
2. Understanding what a construct *means*: prose docs in `urls.md`.
3. The source is the truth. If the snapshot disagrees with the parser, trust
   the parser.

## Integration with grammar work

The IDE Lezer grammar lives at `packages/ide/src/lib/cm/lean.grammar`. The
acceptance corpus is the LiCriterion project (see project memory) — 14K LOC
of real Lean 4.27.

The grammar is intentionally **coarse**: top-level structure only (commands,
declarations, blocks, comments), with expression and tactic bodies absorbed
as opaque token streams. This is the right tier given that Lean's grammar is
user-extensible (every `notation`/`syntax`/`macro_rules` adds new constructs)
and a complete grammar is unachievable.
