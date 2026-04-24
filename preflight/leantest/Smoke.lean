-- Minimal smoke file: used by node-smoke.spec.ts
-- Exercises: parser, elaborator, term-level compute, #eval of stdlib.
import Std

def hello : String := "hello from wasm"

#eval hello

def sumTo (n : Nat) : Nat :=
  (List.range n).foldl (· + ·) 0

#eval sumTo 10
#eval sumTo 100
