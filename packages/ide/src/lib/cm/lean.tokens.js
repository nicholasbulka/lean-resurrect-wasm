// External tokenizer slot for Lean 4 — currently unused. Phase 3b uses a
// regex-based BlockComment that does not nest. If the corpus surfaces a
// nested-comment misparse, revisit using ExternalTokenizer here.
//
// Reference: vendor/lean4-src/src/Lean/Parser/Basic.lean:537
// (finishCommentBlock — uses a depth counter for /-...-/ nesting).
