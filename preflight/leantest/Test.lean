import Std

def hello : String := "hello from wasm"

#eval hello

def sum (n : Nat) : Nat :=
  (List.range n).foldl (· + ·) 0

#eval sum 10
#eval sum 100
