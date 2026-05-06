# Reproducible wasm32 dependency builds

This Docker image cross-compiles a pegged Lean library set to wasm32 and
packs the resulting oleans into a CDN bundle.

## Why Docker?

Cross-compiling Mathlib (or any sizable Lean library) involves:

- a vendored wasm32 lean toolchain (we ship in `vendor/lean-linux_wasm32`),
- a host-arch lake for orchestration,
- a small Node harness (`preflight/trace_fs.js`),
- exact pinned commits for every transitive dep,
- builds that take hours to overnight.

Wrapping it in Docker means: any machine with Docker can produce the
same bundle, given the same `config/wasm-deps.json`. The image is the
build environment; the `cdn/projects/<slug>/build-manifest.json` proves
which inputs produced which outputs.

## Building the image

```
docker build -f docker/Dockerfile.build-wasm-deps -t lean-wasm-build:v4.27.0 .
```

Or via the wrapper, which builds on first run:

```
scripts/build-wasm-deps.sh mathlib-v4.27.0-2026-04 --build-image
```

## Running a build

```
scripts/build-wasm-deps.sh <library-key> [flags]
```

Library keys come from `config/wasm-deps.json` under `.libraries`. Right
now: `mathlib-v4.27.0-2026-04`, `li-criterion`.

### Flags

| Flag | Effect |
|---|---|
| `--allow-nonhash-rev` | Accept refs that aren't 40-char hex (tags, branches). Hard-blocked by default for idempotency. |
| `--allow-date-violation` | Accept Mathlib commits > 90 days from Lean release date. Catches obvious time-travel pegs. |
| `--strict` | Turn every validator warning into an error. |
| `--force-rebuild` | Wipe `.build-cache/wasm-deps/<library-key>/` before cloning. |
| `--dry-run` | Validate + clone + write manifest, but skip the cross-compile step. |
| `--image=<tag>` | Use a specific image tag. Default `lean-wasm-build:v4.27.0`. |
| `--build-image` | (Re)build the image before running. |

## Output layout

```
cdn/projects/<cdnSlug>/
  oleans.bundle                     packed wasm32 oleans (per server.js wire format)
  sources.json                      .lean sources (when shipped alongside)
  build-logs/<buildId>/
    build-manifest.json             reproducibility record (see schema below)
    build.log                       merged stdout/stderr
    events.jsonl                    structured event stream
    deps.jsonl                      one record per dep clone (name, url, rev, commitDate)
    validation-report.json          validator output
```

Every build attempt gets its own `<buildId>` (UTC timestamp + PID), so
re-runs accumulate rather than overwrite. The trace dir is the audit
log; if the bundle is regenerated, the operator can compare the new
manifest against an old one to see exactly what changed.

## `build-manifest.json` schema

```json
{
  "buildId": "20260506T123456Z-42",
  "libraryKey": "mathlib-v4.27.0-2026-04",
  "cdnSlug": "mathlib-v4.27.0-2026-04",
  "topLevel": "mathlib",
  "startedAt": "2026-05-06T12:34:56Z",
  "endedAt":   "2026-05-06T18:42:11Z",
  "durationSec": 22035,
  "crossCompilePath": "manual",
  "buildStatus": "success",
  "bundle": {
    "sha256": "<hex>",
    "byteCount": 412345678,
    "oleanCount": 6182
  },
  "validation": { /* validator report */ },
  "deps": [
    { "name": "mathlib", "url": "...", "rev": "a3a10db0…", "commitDate": "2026-04-08T17:23:01Z", "kind": "git" },
    ...
  ],
  "events": [
    { "ts": "...", "level": "INFO", "msg": "..." }, ...
  ]
}
```

## Cross-compile mechanism (TODO)

The container clones, validates, and writes a manifest correctly today.
The actual `lake build` invocation is the open piece. Three options live
in `docker/build-wasm-deps-entry.sh` under `CROSS_COMPILE_PATH`:

- `manual` (default, recommended): walk the dep graph topologically, call
  `node preflight/trace_fs.js -o <out.olean> -i <out.ilean> -R <pkg> <file.lean>`
  for each `.lean` file. No host-arch lake tricks. Slow but predictable.
- `qemu-lake`: run native lake under qemu-user with a shim that forwards
  every `lean` invocation to the wasm32 binary. Fragile.
- `xbuild`: hypothetical upstream Lean target.

Until one is implemented end-to-end, runs default to `--dry-run` style
behavior — clone + manifest, no bundle. The dep tree is left at
`.build-cache/wasm-deps/<library-key>/` for an operator to drive
manually if desired.

## Operator notes

- The image is intentionally heavy (lean + lake + node). Build once,
  reuse for every library set.
- Re-running with `--force-rebuild` wipes the scratch clone tree but
  keeps the per-build `build-logs/` dirs — those are the audit trail.
- `local://` URLs in the pegs file (e.g. for the LiCriterion local
  checkout) are NOT cloned; the build expects an additional mount
  from the host. To support them, add a bind mount in
  `scripts/build-wasm-deps.sh` for the user's checkout. Currently
  unimplemented; remote-only deps work today.
