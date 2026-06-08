# Mathlib v4.27 wasm32 cross-compile — open items

## RESOLVED 2026-06-07

The heartbeat hypothesis below was correct, with one addendum: there are
THREE deterministic budgets, not two. Final state:

- **7,515/7,516 Mathlib modules compiled** (7,912 oleans incl. deps) in
  `cdn/projects/mathlib-v4.27.0-2026-04/build`.
- `maxHeartbeats=800000` + `maxSynthPendingDepth=8` cleared both root
  failures below (Dual/Lemmas, Monoidal/Grp_) — zero cascade.
- One new failure class surfaced: `synthInstance.maxHeartbeats` (default
  20000, a separate budget) timed out on
  `NumberTheory/ModularForms/NormTrace` — a `DivisionMonoid ↥ℋ` search
  that fails-fast natively blew the budget on wasm. Retried clean with
  80000 via `scripts/retry-heartbeat-experiment.js`; artifacts saved to
  the bundle. All three budgets now passed by the orchestrator via `-D`
  (env-overridable).
- The root `Mathlib` module (imports everything) OOMs at the 4 GB wasm32
  ceiling. Won't-fix: users import submodules, never `import Mathlib`.

Remaining: pack `oleans.bundle` from the build dir when ready to ship.

---

Working tree state at pause (~2026-05-19, build still running).

## Build state

- Orchestrator pid 9285, log `logs/mathlib-host-20260514T145148.log`
- ~38% through mathlib (2,873 / 7,516 oleans on disk)
- 1,711 ✓ new compiles, 842 ↻ resumed, **26 ✗ all clustered around two real root failures + cascade**

The 4 GB `MAXIMUM_MEMORY` relink (commit `837498b`) cleared the OOM class entirely. No memory panics since.

## The two real root failures

Not memory errors, not crashes. Deterministic Lean elaboration errors that ran for ~5 minutes before failing.

### Root 1 — `Mathlib/LinearAlgebra/Dual/Lemmas.lean:684`

```lean
rw  [Nondegenerate, separatingLeft_iff_ker_eq_bot, separatingRight_iff_flip_ker_eq_bot]
simp_rw [ker_eq_bot]
exact ⟨W.quotDualCoannihilatorToDual_injective,
       W.flip_quotDualCoannihilatorToDual_injective⟩  -- line 684
```

Error says the *second* component has type `Function.Injective ⇑...flip` but is expected to have type `....flip.ker = ⊥`. The `simp_rw [ker_eq_bot]` rewrite **only fired on the first conjunct**.

Same file also fails at line 974:
`failed to synthesize instance FiniteDimensional K (Dual K ↥W)`.

### Root 2 — `Mathlib/CategoryTheory/Monoidal/Grp_.lean:619`

```lean
braided X Y := (Grp.forget₂Mon _).map_injective (Braided.braided X.toMon Y.toMon)
```

Application type mismatch: the argument's `«μ» ?m.70 X.toMon Y.toMon ...` (placeholder metavariable) doesn't unify with the expected `«μ» F.mapGrp X Y ...`. The elaborator left a metavar uninstantiated.

### Cascade

12 modules in `LinearAlgebra/Contraction → Coevaluation → Algebra/Category/FGModuleCat/*` fail because `Dual.Lemmas.olean` is missing. 11 more in `CategoryTheory/Monoidal/{CommGrp_,Internal/Types/Grp_,Internal/Types/CommGrp_}` and `Algebra/Category/Grp/LeftExactFunctor` fail because `Monoidal.Grp_.olean` is missing.

## Working hypothesis: wasm elaboration timeout surfacing as silent partial state

(Validated indirectly; cheap experiment queued below.)

Both failures show the **partial-progress signature**: a tactic that does multiple operations (simp_rw traversal, typeclass elaboration) appears to bail mid-flight, swallow the abort, and leave a corrupted goal that the *next* tactic reports.

Relevant facts:
- **mathlib's `mathlibLeanOptions` does NOT bump `maxHeartbeats`** (verified `lakefile.lean:46-52`). All 7,517 modules run with Lean's default 200K budget.
- Mathlib sets `maxSynthPendingDepth := 3`, capping typeclass-synthesis recursion. Under MT=ON + PROXY_TO_PTHREAD on wasm, the elaborator's task-parallel mvar commits may evolve in a different order than on a fast host, hitting depth 3 where the host wouldn't.
- The orchestrator passes no heartbeat arg to lean (`docker/cross-compile-wasm.js:386-391` — only `-M 8192 -s 8192` which are memory/stack ceilings).
- These specific modules use long elaboration paths; sibling modules using the same `simp_rw [ker_eq_bot]` pattern (Jacobson.Radical, SesquilinearForm.Basic) compiled fine.
- The Lean v4.27 wasm patches (`memory.cpp`, `interrupt.cpp`, `compact.cpp`, `module.cpp`, `io.cpp`, `ir_interpreter.cpp`, `object.cpp`, `thread.h`) are FFI signature fixes + MT=OFF safety guards. They do not touch the elaborator, simp engine, or typeclass resolution.

So the user's intuition is the most parsimonious: **wasm's slower runtime stretches the heartbeat/depth window into ranges that a native build skates through**, surfacing borderline-fragile mathlib proofs that wouldn't normally trip.

## Validation experiment — DO this when the main build finishes

Retry one module with the heartbeat budget raised. Two equivalent approaches:

1. **Patch the file**, then invoke trace_fs.js standalone:
   ```bash
   # at top of Dual/Lemmas.lean:
   set_option maxHeartbeats 800000
   set_option maxSynthPendingDepth 8

   # then:
   node preflight/trace_fs.js -M 8192 -s 8192 \
     -o vendor/lean-linux_wasm32/lib/lean/Mathlib/LinearAlgebra/Dual/Lemmas.olean \
     -i vendor/lean-linux_wasm32/lib/lean/Mathlib/LinearAlgebra/Dual/Lemmas.ilean \
     -R .build-cache/mathlib-v4.27.0-2026-04/mathlib \
     .build-cache/mathlib-v4.27.0-2026-04/mathlib/Mathlib/LinearAlgebra/Dual/Lemmas.lean
   ```
   Expected cost: ~5 min, ~5 GB RSS. Don't run while the main orchestrator's child is mid-compile if RAM is tight.

2. **Pass `--max-heartbeats=0`** as a trailing CLI arg (Lean accepts it; trace_fs.js just forwards argv through callMain).

Decision tree from result:

- **Compiles cleanly with raised budgets** → confirmed wasm-elaboration-timeout hypothesis. Solutions:
  - Cheapest: patch only the failing files in `.build-cache/.../mathlib/Mathlib/` with `set_option maxHeartbeats N` at the top.
  - Better: bump the orchestrator's default via env or compile arg, e.g. `--max-heartbeats=800000`. Probably worth doing globally for the whole mathlib build — it's free for fast modules.
  - Best: add `maxHeartbeats := .ofNat 800000` to `mathlibLeanOptions` in our pegs/wrapped mathlib. But touching the wrapped checkout invalidates the resume cache.
- **Fails identically** → real upstream Mathlib bug at commit `a3a10db0`. File issue / patch the source.
- **Fails differently** → race condition; investigate MT=ON task ordering.

## What NOT to do

- Don't restart the orchestrator just to retry the 2 modules — they'd just fail again with the same defaults. Wait for the main build to finish, then retry the slice in isolation.
- Don't rebuild lean.wasm yet. The 4 GB relink (`docker/relink-4gb.sh`) is the right binary; the elaborator behavior won't change with a relink.
- Don't bump `MAXIMUM_MEMORY` past 4 GB — that's the wasm32 hard ceiling, and full wasm64 rebuild is a multi-day expedition (see memory `lean_wasm_release_status`).

## When this is solved

Commit anything that ends up in `docker/cross-compile-wasm.js` (probably: pass `--max-heartbeats=N` via env). Add `feedback_wasm_elaboration_timeout.md` to memory documenting that wasm-build mathlib needs a higher heartbeat budget than the default, with this incident as the why.
