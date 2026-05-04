# Phase 11.0 — Asyncify rebuild track: acceptance + regression bar

This document defines what "success" means for Phase 11.0 and which
existing capabilities MUST continue to work for the rebuild track to
ship anything to main.

The rebuild is **additive**: new artifacts (`lean-asyncify.{js,wasm}`
or `lean-jspi.{js,wasm}`) live alongside the production
`lean.{js,wasm}` in `build-wasm/stage1/bin/`. Production binaries at
`vendor/lean-linux_wasm32/bin/` MUST NOT be touched by this work.

## Success criteria for Phase 11.0

A Phase 11.0 outcome is one of three states. Each is a clean stopping
point.

### A. Full success
- New binary loads in Node, `--version` reports a Lean version string
- `spike-async.cjs` (or equivalent) completes the full sequence:
  initialize → initialized → didOpen → hover → response, with
  non-empty hover.contents
- Wall-clock per-hover after warmup: <2s on Apple Silicon for the
  trivial test source
- No segfaults, no aborts, no JS errors
- Documented runtime memory footprint (resident heap)

### B. Partial success
- New binary loads and `--version` works
- LSP `initialize` returns a capability response
- One or more later steps (initialized / didOpen / hover) fails
  reproducibly
- Failure mode characterized: which step, what error, which layer
  (Module.stdin, Emscripten TTY get_char, Asyncify suspend, JSPI
  stack switch, Lean LSP elaboration, etc.)
- Recommendation written for the next iteration

### C. Documented dead end
- Build fails to link, OR binary fails `--version` smoke, OR runtime
  aborts during init
- Failure documented with: exact build flags, exact error / signal,
  reproducible repro step, hypothesis on root cause
- Decision recorded: which alternative path is next (different flag
  combo, rebuild without exceptions, refactor Lean LSP loop, etc.)

A → ship and proceed to Phase 11b. B → commit findings, decide
next iteration. C → commit findings, pause Phase 11.0, pivot.

All three states result in a commit with reproducible scripts,
artifacts (or evidence of failure), and a clear write-up. **This
session's purpose is reaching one of A/B/C cleanly, not chasing A
specifically.**

## Regression bar — must still hold

These existing capabilities must work after every Phase 11.0 commit.

### IDE
- `/` loads the React IDE; default scratch project shows in dropdown;
  CodeMirror editor mounts; ⌘↵ binding works.
- "↓ import…" prompt accepts the LiCriterion path; sidebar populates
  with 166 files.
- File tree click switches the editor between project files.
- Graph tab shows the 3-node Sigma demo without errors.
- Architecture tab renders 5 mermaid diagrams.

### Compile pipeline
- `/api/compile` POST with a trivial Lean source (`def x : Nat := 42\n#eval x\n`)
  returns exit code 0 and a diagnostic with `data: "42"`.
- `/api/project/scan` POST with the LiCriterion path returns 166 files.

### Lezer grammar
- `tools/grammar-accuracy/run-corpus.mjs` reports `99.99%` agreement
  on LiCriterion (no regression in the grammar / accuracy harness).
- `tools/grammar-accuracy/perf.mjs` reports cold-parse times within
  the documented baseline (113ms for ComplexBinet2.lean).

### Browser test suite
- `npx playwright test --project=browser -g 'React IDE'` — 10/10 pass
- `npx playwright test --project=browser -g 'Compile mode toggle'`
  — 2 pass, 1 skipped (browser-mode test pre-existing skip)

### Production WASM binary integrity
- `md5sum vendor/lean-linux_wasm32/bin/lean.wasm` matches the value
  recorded in the previous commit (no accidental clobber).
- `md5sum vendor/lean-linux_wasm32/bin/lean.js` matches likewise.
- `node --max-old-space-size=10240 scripts/mt-on-run.sh
  packages/ide/trivial.lean` returns `42` from the existing MT=ON
  build.

## Verification command bundle

```bash
# 1. Production binary integrity (ensures rebuild didn't clobber).
md5sum vendor/lean-linux_wasm32/bin/lean.{js,wasm}

# 2. Compile pipeline.
curl -s -X POST http://localhost:8787/api/compile \
  -H 'content-type: application/json' \
  -d '{"source":"def x : Nat := 42\n#eval x\n"}' \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print('exit', r['exitCode'], 'diags', [d['data'] for d in r['diagnostics']])"

# 3. Project scan.
curl -s -X POST http://localhost:8787/api/project/scan \
  -H 'content-type: application/json' \
  -d '{"root":"/Users/nicholasbulka/prog/lean/liCriterionLean4Web/services/lean4web/Projects/LiCriterion"}' \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['files']), 'files')"

# 4. Grammar accuracy.
cd tools/grammar-accuracy && node run-corpus.mjs | head -16

# 5. Browser tests.
cd packages/tests && npx playwright test --project=browser --reporter=line | tail -20

# 6. New binary smoke (the Phase 11.0 deliverable).
BINARY_DIR=$(pwd)/build-wasm/stage1/bin LEAN_JS=lean-jspi.js \
  node tools/lsp-spike/smoke-asyncify.cjs

# 7. New binary continuous LSP (the Phase 11.0 stretch goal).
BINARY_DIR=$(pwd)/build-wasm/stage1/bin LEAN_JS=lean-jspi.js \
  node tools/lsp-spike/spike-async.cjs
```

A clean Phase 11.0 commit:
- Items 1–5 all pass (no regressions)
- Item 6 succeeds (smoke)
- Item 7's outcome (success / characterized failure) is documented in
  RESULTS.md

## Rollback plan

If at any point regressions appear, the rollback is a single-line git
revert of the offending commit. The rebuild branch lives in
`tools/lsp-spike/` and `docker/`; nothing in `packages/` should change.
The production WASM at `vendor/lean-linux_wasm32/` is git-tracked
LFS-style large files but git status will catch any modification.
