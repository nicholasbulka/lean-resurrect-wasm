/-
  Dump tokens emitted by Lean's own parser as JSONL.

  Usage:  lean --run dump-tokens.lean <input.lean>

  Per-line schema: {"kind": "atom"|"ident", "from": int, "to": int, "text": str}

  Notes:
  - Uses an empty Environment, so user-defined notation in the file won't be
    recognized. Bodies that depend on Mathlib notation will produce parse
    errors but the leading structure (imports, declaration heads, keyword
    positions, identifiers) still emits correctly.
  - v1: emits only atoms and identifiers (Syntax.atom, Syntax.ident). Comments
    live in leading/trailing trivia and are not emitted yet.
-/

import Lean
import Lean.Parser.Module
open Lean

partial def collectTokens (stx : Syntax) (acc : Array (String × Nat × Nat × String)) : Array (String × Nat × Nat × String) :=
  match stx with
  | .missing => acc
  | .atom info val =>
    match info.getPos? with
    | none => acc
    | some pos =>
      let endPos := info.getTailPos?.getD pos
      acc.push ("atom", pos.byteIdx, endPos.byteIdx, val)
  | .ident info _ name _ =>
    match info.getPos? with
    | none => acc
    | some pos =>
      let endPos := info.getTailPos?.getD pos
      acc.push ("ident", pos.byteIdx, endPos.byteIdx, name.toString)
  | .node _ _ args =>
    args.foldl (fun a c => collectTokens c a) acc

partial def parseAllLoose
    (env : Environment) (inputCtx : Lean.Parser.InputContext)
    (state : Lean.Parser.ModuleParserState) (msgs : MessageLog)
    (stxs : Array Syntax) : Array Syntax :=
  let (stx, state', _msgs') := Lean.Parser.parseCommand inputCtx { env := env, options := {} } state msgs
  if Lean.Parser.isTerminalCommand stx then
    stxs
  else
    parseAllLoose env inputCtx state' msgs (stxs.push stx)

def escapeJson (s : String) : String :=
  s.foldl (fun acc c =>
    match c with
    | '"' => acc ++ "\\\""
    | '\\' => acc ++ "\\\\"
    | '\n' => acc ++ "\\n"
    | '\t' => acc ++ "\\t"
    | '\r' => acc ++ "\\r"
    | c =>
      if c.toNat < 32 then
        acc ++ "?"
      else
        acc.push c
  ) ""

def main (args : List String) : IO UInt32 := do
  let path := args.headD ""
  if path.isEmpty then
    IO.eprintln "usage: lean --run dump-tokens.lean <file.lean>"
    return 1
  let contents ← IO.FS.readFile path
  let env ← mkEmptyEnvironment
  let inputCtx := Lean.Parser.mkInputContext contents path
  let (header, state, messages) ← Lean.Parser.parseHeader inputCtx
  let cmds := parseAllLoose env inputCtx state messages #[]
  let allStx := #[header.raw] ++ cmds
  let toks := allStx.foldl (fun a stx => collectTokens stx a) #[]
  let toks := toks.qsort (fun a b => a.2.1 < b.2.1)
  let q : String := "\""
  for (kind, fr, to, text) in toks do
    let line := "{" ++ q ++ "kind" ++ q ++ ":" ++ q ++ kind ++ q
              ++ ",\"from\":" ++ toString fr
              ++ ",\"to\":" ++ toString to
              ++ ",\"text\":" ++ q ++ escapeJson text ++ q
              ++ "}"
    IO.println line
  return 0
