# CDN stub for browser-mode Lean project hosting

This directory mimics a CDN that hosts wasm32-compiled Lean projects.
The server's `/cdn/projects/...` routes serve these files as if from a
remote origin, so the IDE can import a project by id without the user
having a local checkout.

## Layout

```
cdn/
  projects/
    <id>/
      sources.json    # { name, files: [{ path, content }] }
      oleans.bundle   # packed binary (u32 count + per-entry pathLen, path, dataLen, data)
```

`oleans.bundle` uses the same wire format as `/vendor/oleans.bundle`.
**Every olean inside must be wasm32-compatible** — that means built
with the same toolchain as `vendor/lean-linux_wasm32/bin/lean.wasm`
(version, flags, githash all match). The IDE trusts CDN bundles
without running the toolchain compatibility check that fires for
local-disk imports; the CDN host is responsible for ensuring
compatibility.

## Adding a project

1. Compile the project's `.olean` files using the wasm32 toolchain
   that ships with this IDE.
2. Pack them into `oleans.bundle` (use the same packer as the server's
   `getOleanBundle` in `packages/tests/server.js`).
3. Drop the `.lean` source files into `sources.json`.
4. Place under `cdn/projects/<your-id>/`.

Users can then import via the "Download from CDN" flow in the IDE,
selecting your `<id>`.

## Demo project

`hello-wasm/` is a placeholder with one trivial source file and an
empty olean bundle. It exists to prove the wiring; replace it with
real content when wasm32-built artifacts are ready.
