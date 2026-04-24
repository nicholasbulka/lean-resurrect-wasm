-- Stdlib-heavy proxy workload.
-- Real P1 target was Mathlib.Tactic.Linarith which isn't in the v4.15.0
-- linux_wasm32 tarball. This imports a broad swath of Lean's stdlib and
-- exercises the elaborator + tactic framework to stress the WASM heap.
import Lean
import Lean.Elab
import Lean.Meta
import Lean.Parser
import Lean.PrettyPrinter
import Std
import Std.Data

open Lean Elab Meta

def bigTerm : Nat :=
  (List.range 1000).foldl (fun acc n => acc + n * n + n % 7) 0

#eval bigTerm

def pyramid (n : Nat) : List (List Nat) :=
  (List.range n).map (fun i => List.range (i + 1))

#eval pyramid 20 |>.length

-- A moderately expensive term-level computation to push elaboration
def checksum (xs : List Nat) : Nat :=
  xs.foldl (fun acc x => acc * 31 + x) 0

#eval checksum (List.range 500)

-- Force some meta / tactic machinery to initialize
example : ∀ (n : Nat), n + 0 = n := by
  intro n
  rfl

example : ∀ (xs : List Nat), xs.length ≥ 0 := by
  intros
  simp
