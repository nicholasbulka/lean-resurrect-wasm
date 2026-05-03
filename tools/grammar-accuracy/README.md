# Grammar accuracy harness

Compares our Lezer grammar's tokenization to Lean's own parser output on
real Lean source. Ground truth is Lean 4.27 itself (native install at
`~/.elan/toolchains/leanprover--lean4---v4.27.0`, version-matched to our
WASM build).

## Files

- `dump-tokens.lean` — Lean program. Uses `Lean.Parser.parseHeader` +
  `Lean.Parser.parseCommand` over an empty environment, walks the
  resulting Syntax tree, emits per-token JSONL: `{kind, from, to, text}`.
  Empty-env parsing means user-defined notation (most Mathlib syntax)
  doesn't fully parse, but top-level structure (commands, declaration
  heads, identifiers, comments) emits correctly.
- `diff.mjs` — Node script. Reads Lean's output, runs our Lezer grammar
  via `@lezer/generator/buildParser` on the same file, walks the tree,
  computes per-byte agreement on a normalized category vocabulary
  (keyword, ident, number, string, char, comment, punct, other).
- `run-corpus.mjs` — Iterates `diff.mjs` over the LiCriterion corpus and
  aggregates totals + a worst-files list.
- `baseline-2026-05-03.txt` — last full-corpus run for regression
  reference.

## Running

```bash
# Single file
node diff.mjs /path/to/SomeFile.lean

# Whole corpus (LiCriterion default)
node run-corpus.mjs

# Custom corpus
node run-corpus.mjs /path/to/lean/project
```

Native `lean` must be on PATH. Verify with `lean --version` (expect
4.27.0).

## Current baseline

LiCriterion (166 files, 5.7 MB):

- **99.88% per-byte agreement** on bytes Lean classifies
- 11.1% Lean-coverage (rest is whitespace/comment trivia, which Lean's
  Syntax tree doesn't emit as standalone tokens — comments are part of
  leading/trailing trivia)
- 77.1% Lezer-coverage (the difference is whitespace `@skip`-ed by our
  grammar)

## Known gaps

- Block-comment misparse in heavy-macro files (e.g.,
  `PrimeNumberTheoremAnd/Tactic/AdditiveCombination.lean`, 88.73%).
  Suspected cause: doc-comment body content with embedded `\``-quoted
  Lean syntax confuses the regex-based block-comment matcher. Will
  improve when the external tokenizer for nested comments works.
- `dump-tokens.lean` v1 emits only atoms and idents; comments live in
  trivia and aren't yet emitted. Lean's "comment" classification used
  here is inferred from atom text matching `/-`/`-/` prefixes/suffixes.

## What this tells us

- Our grammar's keyword classification, identifier recognition (incl.
  Unicode subscripts and math-bold letters), qualified-name handling,
  and doc-comment recognition all agree with Lean's parser at the
  per-byte level on real Mathlib-using code.
- Remaining mismatches are concentrated in a handful of files using
  unusual macro syntax. Worth investigating as we go.
