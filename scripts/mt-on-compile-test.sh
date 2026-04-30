#!/usr/bin/env bash
# Try a real compile with MT=ON. Output goes directly to console
# (worker stdout, won't be captured but visible via inherit).
set -uo pipefail
LEAN_ROOT=${LEAN_ROOT:-/tmp/leanroot}
# Place the test file inside /tmp/leanroot so the worker's NODEFS mount
# can see it. Workers only mount /tmp/leanroot, not /tmp generally.
mkdir -p "$LEAN_ROOT/work"
cat > "$LEAN_ROOT/work/Input.lean" <<'EOF'
def x : Nat := 42
#eval x
EOF

NODE_OPTIONS="--max-old-space-size=10240" \
node -e "
(() => {
const LEAN_ROOT = '$LEAN_ROOT';
let done = false;
global.Module = {
  noInitialRun: true,
  onExit: (status) => { console.log('[onExit] status=' + status); done = true; process.exit(status); },
  onAbort: (what) => { console.error('[onAbort]', what); process.exit(3); },
};
require(LEAN_ROOT + '/bin/lean.js');
const wait = () => {
  if (!global.Module.calledRun) { setTimeout(wait, 100); return; }
  console.log('[harness] running compile...');
  try {
    const root = require('fs').realpathSync('/tmp/leanroot') + '/work';
    const args = ['--json', '-R', root, root + '/Input.lean'];
    console.log('[harness] callMain args:', JSON.stringify(args));
    global.Module.callMain(args);
  } catch(e) { console.log('[callMain THREW]', e && (e.message || e)); }
};
wait();
setTimeout(() => {
  if (!done) {
    console.log('[timeout] 240s elapsed, killing');
    process.exit(2);
  }
}, 240_000);
})();
"
