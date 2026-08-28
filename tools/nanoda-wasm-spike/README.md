# nanoda-wasm-spike — a client-side Lean proof checker in wasm

Compiles the Rust Lean kernel [`nanoda_lib`](https://github.com/ammkrn/nanoda_lib)
to WebAssembly and runs it as an **independent proof checker** — no Lean
toolchain, no emscripten, no fork/pthreads. It verifies `lean4export` output
(fully-elaborated terms), so it does **not** elaborate: it can't run tactics or
give edit-time errors. It answers one question — *is this proof valid, using only
the permitted axioms?* — with a sub-megabyte, auditable trusted base.

## Result (2026-08-28, Lean 4.34.0-rc1)

| | |
|---|---|
| `nanoda_bin.wasm` | **819 KB** (`wasm32-wasip1`, pure-Rust deps, single-threaded) |
| Toy check (`Nat.add` closure) | ✅ "Checked 17 declarations with no typechecker errors" |
| Full [li-criterion RH-equivalence](https://github.com/nicholasbulka/li-criterion-rh-equivalence-lean) proof | ✅ **65,290 declarations, no errors**, axioms `{propext, Quot.sound, Classical.choice}` |
| Memory | native peak ~677 MB; wasm ~2× native time — well under the wasm32 4 GB ceiling |

## Files

- `Dockerfile` — two stages: `build` (nanoda → `wasm32-wasip1`) and `run`
  (debian + `wasmtime` + the `.wasm`).
- `nanoda_bin.wasm` — the checker (tracked; the reusable deliverable).
- `config.json` — checker config: `use_stdin`, `permitted_axioms`, and the
  **`nat_extension` / `string_extension` flags the proof needs** (see gotcha).
- `toy.ndjson` — tiny smoke-test export (tracked).
- `li-criterion.ndjson` — 458 MB full-proof export (**gitignored**; regenerate below).

## Build

```sh
docker build --target build -t nanoda-wasm-build .   # produces the .wasm
docker build --target run   -t nanoda-wasm .         # + wasmtime, runnable
# extract the artifact:
id=$(docker create nanoda-wasm-build); docker cp "$id:/out/nanoda_bin.wasm" .; docker rm "$id"
```

## Run (check an export)

```sh
docker run --rm -i -v "$PWD:/work" nanoda-wasm \
  wasmtime run --dir /work /nanoda/nanoda_bin.wasm /work/config.json < toy.ndjson
```

## Regenerate the full-proof export

Needs `lean4export` built against the **same** toolchain as the proof
(4.34.0-rc1) and the proof already built (`lake build`):

```sh
git clone https://github.com/leanprover/lean4export && cd lean4export
echo "leanprover/lean4:v4.34.0-rc1" > lean-toolchain && lake build
# from the proof repo (so `lake env` sets LEAN_PATH to its oleans + Mathlib):
cd /path/to/li-criterion-rh-equivalence-lean
lake env /path/to/lean4export/.lake/build/bin/lean4export Solution \
  -- li_criterion li_coefficients_eq_zero_sum > li-criterion.ndjson
```

## Gotcha

The proof uses Nat/String literals, so the config **must** set
`"nat_extension": true` and `"string_extension": true` (off by default →
`Nat lit extension disallowed by checker execution config`). The
`Unable to print axioms` pretty-printer message is cosmetic, not a check error.

## Browser port (next)

`wasm32-wasip1` runs in a browser with a JS WASI shim (stdin + a fetched
export), or recompile to `wasm32-unknown-unknown` with thin glue. For an
interactive "verify this file" feel, export per-file import closures rather than
shipping the whole 458 MB.
