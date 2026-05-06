#!/usr/bin/env bash
# After a successful cli-only cross-compile, set up the CDN entry and
# smoke-test that the IDE can import + browser-mode-compile against it.
#
# Prereq: /tmp/cli-only-build/ contains the wasm32 oleans (cross-compile
#         output) and cdn/projects/cli-only/oleans.bundle has been packed.
# Or pass --pack to run the pack step.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "--pack" ]; then
  echo "[smoke] packing /tmp/cli-only-build into bundle"
  node docker/pack-bundle.js /tmp/cli-only-build cdn/projects/cli-only/oleans.bundle
fi

mkdir -p cdn/projects/cli-only
if [ ! -f cdn/projects/cli-only/sources.json ]; then
  cat > cdn/projects/cli-only/sources.json <<'EOF'
{
  "name": "cli-only",
  "files": [
    {
      "path": "Main.lean",
      "content": "import Cli\n\nopen Cli\n\n#check @Cmd\n#check @validate\n"
    }
  ]
}
EOF
fi

ls -la cdn/projects/cli-only/

echo "[smoke] open the IDE, click '☁ from CDN…', enter 'cli-only', then compile Main.lean"
