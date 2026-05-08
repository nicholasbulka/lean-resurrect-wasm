# Lean v4.27.0 wasm32+MT=ON patches

This directory contains the patch series that turns an upstream
Lean v4.27.0 checkout into the wasm32-MT=ON binary at
`vendor/lean-linux_wasm32/`. See `../lean-source-patches.md` for
the per-file inventory and rationale.

## Reproduce from a fresh upstream Lean

```bash
git clone https://github.com/leanprover/lean4.git
cd lean4
git checkout db93fe1608548721853390a10cd40580fe7d22ae   # v4.27.0
git am ../path/to/this-repo/docs/lean-patches/v4.27.0-wasm32-mt-on.patch
git log -1   # should show "v4.27 wasm32 patches for MT=ON browser/Node-worker target"
```

Then run the build via `docker/build-wasm.sh MULTI_THREAD=ON
PROXY_TO_PTHREAD=1` from this repo.

## Why a patch file and not a fork?

Forking `leanprover/lean4` would make the dependency easier to
consume but adds a GitHub repo we'd need to maintain alongside
upstream. A patch file is sufficient until we have either:

- a multi-version maintenance burden (e.g. v4.28, v4.29 each
  needing a parallel branch), or
- upstream interest in any of the patches (the codegen-vs-extern
  signature fixes in particular are real bugs upstream too — we
  could submit them), or
- enough churn that the rebased patch is non-trivial.

When any of those become true, we'll fork. For now, this file is
the source of truth.

## When upstream Lean changes

Re-base the patch onto the new upstream tag and update the file in
place. Re-run the build and verify the wasm32 lean still passes our
end-to-end smoke (`def x : Nat := 42; #eval x` returning `42` from
the IDE in browser-mode).
