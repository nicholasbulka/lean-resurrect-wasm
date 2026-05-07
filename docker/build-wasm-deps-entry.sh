#!/usr/bin/env bash
# Container entrypoint: clone pegged deps, validate, cross-compile, pack.
#
# Trace fidelity is the priority — every step writes a JSON record to the
# build manifest so a re-run with the same inputs produces the same output
# AND we can answer "where did this olean come from?" months later.
#
# Required env (set by docker run -e or by the host wrapper):
#   LIBRARY_KEY              key under .libraries in $PEGS_FILE
#   PEGS_FILE                /config/wasm-deps.json (mounted ro)
#   PREFLIGHT                /preflight (mounted ro; trace_fs.js etc)
#   WASM_LEAN_ROOT           /wasm-lean (mounted ro; vendor/lean-linux_wasm32)
#   OUT_ROOT                 /out (mounted rw; cdn/ on host)
#   CACHE_ROOT               /cache (mounted rw; .build-cache/ on host)
#
# Optional flags (defaults shown):
#   ALLOW_NONHASH_REV=0     allow refs that aren't 40-char hex
#   ALLOW_DATE_VIOLATION=0  allow Mathlib commit > 90 days from Lean release
#   STRICT=0                turn validator warnings into errors
#   FORCE_REBUILD=0         clear scratch + bundle before building
#   DRY_RUN=0               clone + validate but skip the build step

set -euo pipefail
shopt -s lastpipe

if [ -z "${LIBRARY_KEY:-}" ]; then
  echo "[build-wasm-deps] LIBRARY_KEY not set" >&2
  exit 2
fi

require_dir() { [ -d "$1" ] || { echo "[build-wasm-deps] required mount missing: $1" >&2; exit 2; } }
[ -f "$PEGS_FILE" ] || { echo "[build-wasm-deps] pegs file missing: $PEGS_FILE" >&2; exit 2; }
require_dir "$PREFLIGHT"
require_dir "$WASM_LEAN_ROOT"
require_dir "$OUT_ROOT"
require_dir "$CACHE_ROOT"

mkdir -p "$CACHE_ROOT/$LIBRARY_KEY"
SCRATCH="$CACHE_ROOT/$LIBRARY_KEY"

LIB_JSON=$(jq -e ".libraries[\"$LIBRARY_KEY\"]" "$PEGS_FILE")
CDN_SLUG=$(echo "$LIB_JSON" | jq -r '.cdnSlug')
TOPLEVEL=$(echo "$LIB_JSON" | jq -r '.topLevel')
DEPS_ON=$(echo "$LIB_JSON" | jq -r '.dependsOn // [] | .[]')

OUT_DIR="$OUT_ROOT/projects/$CDN_SLUG"
mkdir -p "$OUT_DIR"

# All build artifacts and traces. One per build attempt; never overwritten.
BUILD_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOG_DIR="$OUT_DIR/build-logs/$BUILD_ID"
mkdir -p "$LOG_DIR"
TRACE="$LOG_DIR/build-manifest.json"
BUILDLOG="$LOG_DIR/build.log"

# Single shared logger: human-readable line on stdout AND structured event in
# the trace's `events` array (a JSON line per event, finalized at the end).
TRACE_EVENTS="$LOG_DIR/events.jsonl"
: > "$TRACE_EVENTS"
log() {
  local level="$1"; shift
  local msg="$*"
  echo "[$level] $msg" | tee -a "$BUILDLOG"
  printf '%s\n' "$(jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg level "$level" --arg msg "$msg" \
    '{ts:$ts, level:$level, msg:$msg}')" >> "$TRACE_EVENTS"
}

START_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_TS=$(date +%s)
log INFO "library=$LIBRARY_KEY slug=$CDN_SLUG topLevel=$TOPLEVEL buildId=$BUILD_ID"
log INFO "ALLOW_NONHASH_REV=${ALLOW_NONHASH_REV:-0} ALLOW_DATE_VIOLATION=${ALLOW_DATE_VIOLATION:-0} STRICT=${STRICT:-0} DRY_RUN=${DRY_RUN:-0} FORCE_REBUILD=${FORCE_REBUILD:-0}"

# Step 0: prerequisite check.
for dep in $DEPS_ON; do
  dep_slug=$(jq -r ".libraries[\"$dep\"].cdnSlug" "$PEGS_FILE")
  if [ ! -f "$OUT_ROOT/projects/$dep_slug/oleans.bundle" ]; then
    log ERROR "prerequisite '$dep' (slug=$dep_slug) not built — run that first"
    exit 3
  fi
  log INFO "prerequisite '$dep' satisfied (oleans.bundle present)"
done

# Step 1: peg validation.
log INFO "validating pegs via /usr/local/lib/validate-pegs.js"
VALIDATOR_FLAGS=()
[ "${ALLOW_NONHASH_REV:-0}" = "1" ]    && VALIDATOR_FLAGS+=(--allow-nonhash-rev)
[ "${ALLOW_DATE_VIOLATION:-0}" = "1" ] && VALIDATOR_FLAGS+=(--allow-date-violation)
[ "${STRICT:-0}" = "1" ]               && VALIDATOR_FLAGS+=(--strict)
node /usr/local/lib/validate-pegs.js "$PEGS_FILE" "$LIBRARY_KEY" "${VALIDATOR_FLAGS[@]}" \
  > "$LOG_DIR/validation-report.json" || {
    log ERROR "validation failed; see $LOG_DIR/validation-report.json"
    exit 4
  }
log INFO "validation passed; report at $LOG_DIR/validation-report.json"

# Optional cleanup before clone.
if [ "${FORCE_REBUILD:-0}" = "1" ]; then
  log WARN "FORCE_REBUILD=1 — wiping $SCRATCH"
  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH"
fi

# Step 2: clone every dep at its pegged rev. Capture commit dates for the
# manifest so reproducibility audits don't require re-cloning.
log INFO "cloning deps into $SCRATCH"
DEPS_TRACE="$LOG_DIR/deps.jsonl"; : > "$DEPS_TRACE"
echo "$LIB_JSON" | jq -c '.deps[]' | while read -r dep; do
  name=$(echo "$dep"   | jq -r '.name')
  url=$(echo "$dep"    | jq -r '.url')
  rev=$(echo "$dep"    | jq -r '.rev')
  dir="$SCRATCH/$name"
  if [ "${url#local://}" != "$url" ]; then
    log INFO "[$name] local:// URL — skipping clone (build will reference user mount)"
    printf '%s\n' "$(jq -nc --arg n "$name" --arg url "$url" --arg rev "$rev" \
      '{name:$n, url:$url, rev:$rev, kind:"local"}')" >> "$DEPS_TRACE"
    continue
  fi
  if [ ! -d "$dir/.git" ]; then
    log INFO "[$name] git clone $url"
    git clone --filter=blob:none "$url" "$dir" >> "$BUILDLOG" 2>&1
  fi
  cur=$(git -C "$dir" rev-parse HEAD)
  if [ "$cur" != "$rev" ]; then
    log INFO "[$name] checkout $rev (was $cur)"
    git -C "$dir" fetch origin "$rev" >> "$BUILDLOG" 2>&1 || git -C "$dir" fetch origin >> "$BUILDLOG" 2>&1
    git -C "$dir" checkout --quiet "$rev"
  else
    log INFO "[$name] already at $rev"
  fi
  cdate=$(git -C "$dir" show -s --format=%cI "$rev")
  log INFO "[$name] commit_date=$cdate"
  printf '%s\n' "$(jq -nc --arg n "$name" --arg url "$url" --arg rev "$rev" --arg cdate "$cdate" \
    '{name:$n, url:$url, rev:$rev, commitDate:$cdate, kind:"git"}')" >> "$DEPS_TRACE"
  # Per-package post-clone hooks. ProofWidgets's library modules
  # `include_str!` JS files produced by an npm build we don't run;
  # stub them so Lean's elaboration still succeeds. Idempotent.
  case "$name" in
    proofwidgets)
      bash /usr/local/lib/stub-proofwidgets-js.sh "$dir" 2>&1 | tee -a "$BUILDLOG" || true
      ;;
  esac
done

# Step 3: cross-compile.
#
# CROSS_COMPILE_PATH chooses the strategy. Three options on the table:
#   "manual"      walk the dep tree topologically, call
#                 node $PREFLIGHT/trace_fs.js -o <out.olean> -i <out.ilean>
#                 -R <pkg> <file.lean> for each .lean, in dep order. Slow,
#                 but no dependency on host-arch lake tricks. Recommended
#                 default to start.
#   "qemu-lake"   run native lake under qemu-user with a wrapper script
#                 that forwards every `lean` invocation to the wasm32
#                 binary via our preflight harness. Fragile, depends on
#                 lake not assuming host-arch lean.
#   "xbuild"     wait for upstream Lean's xbuild target. Hypothetical.
#
# Until one of those lands, we DRY_RUN and surface the dependency tree to
# the operator so they can attempt option (a) by hand.
CROSS_COMPILE_PATH="${CROSS_COMPILE_PATH:-manual}"
log INFO "CROSS_COMPILE_PATH=$CROSS_COMPILE_PATH"

if [ "${DRY_RUN:-0}" = "1" ]; then
  log WARN "DRY_RUN=1 — skipping build step"
  BUILD_STATUS="dry-run"
  BUNDLE_BYTES=0
  BUNDLE_SHA="(none)"
  OLEAN_COUNT=0
elif [ "$CROSS_COMPILE_PATH" = "manual" ]; then
  log INFO "running manual cross-compile (per-file lean invocations)"
  BUILD_OUT="$OUT_DIR/build"
  mkdir -p "$BUILD_OUT"
  if PEGS_FILE="$PEGS_FILE" \
     LIBRARY_KEY="$LIBRARY_KEY" \
     SCRATCH="$SCRATCH" \
     PREFLIGHT="$PREFLIGHT" \
     WASM_LEAN_ROOT="$WASM_LEAN_ROOT" \
     OUT_DIR="$BUILD_OUT" \
     ABORT_ON_FAIL="${ABORT_ON_FAIL:-0}" \
     node /usr/local/lib/cross-compile-wasm.js 2>&1 | tee -a "$BUILDLOG"; then
    log INFO "cross-compile succeeded"
    log INFO "packing oleans into $OUT_DIR/oleans.bundle"
    node /usr/local/lib/pack-bundle.js "$BUILD_OUT" "$OUT_DIR/oleans.bundle" 2>&1 | tee -a "$BUILDLOG"
    BUNDLE_BYTES=$(stat -c%s "$OUT_DIR/oleans.bundle" 2>/dev/null || stat -f%z "$OUT_DIR/oleans.bundle")
    BUNDLE_SHA=$(sha256sum "$OUT_DIR/oleans.bundle" | awk '{print $1}')
    OLEAN_COUNT=$(find "$BUILD_OUT" -name '*.olean' | wc -l | tr -d ' ')
    BUILD_STATUS="success"
    log INFO "bundle: $OLEAN_COUNT oleans, $BUNDLE_BYTES bytes, sha256=$BUNDLE_SHA"
  else
    log ERROR "cross-compile failed; see $BUILDLOG and $BUILD_OUT/cross-compile-report.json"
    BUILD_STATUS="compile-failed"
    BUNDLE_BYTES=0
    BUNDLE_SHA="(none)"
    OLEAN_COUNT=$(find "$BUILD_OUT" -name '*.olean' 2>/dev/null | wc -l | tr -d ' ')
  fi
else
  log ERROR "CROSS_COMPILE_PATH=$CROSS_COMPILE_PATH not implemented"
  log ERROR "supported: manual (default). qemu-lake and xbuild are placeholders."
  BUILD_STATUS="not-implemented"
  BUNDLE_BYTES=0
  BUNDLE_SHA="(none)"
  OLEAN_COUNT=0
fi

# Step 4: write the build manifest. Always written — even on partial
# failure — because the trace itself has value.
END_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
END_TS=$(date +%s)
DURATION_SEC=$((END_TS - START_TS))

# Slurp deps + events into the trace.
DEPS_ARRAY=$(jq -s '.' < "$DEPS_TRACE")
EVENTS_ARRAY=$(jq -s '.' < "$TRACE_EVENTS")
VALIDATION=$(cat "$LOG_DIR/validation-report.json" 2>/dev/null || echo 'null')

jq -n \
  --arg buildId "$BUILD_ID" \
  --arg libraryKey "$LIBRARY_KEY" \
  --arg cdnSlug "$CDN_SLUG" \
  --arg topLevel "$TOPLEVEL" \
  --arg startAt "$START_AT" \
  --arg endAt "$END_AT" \
  --argjson durationSec "$DURATION_SEC" \
  --arg buildStatus "$BUILD_STATUS" \
  --arg bundleSha "$BUNDLE_SHA" \
  --argjson bundleBytes "$BUNDLE_BYTES" \
  --argjson oleanCount "$OLEAN_COUNT" \
  --arg crossCompilePath "$CROSS_COMPILE_PATH" \
  --argjson validation "$VALIDATION" \
  --argjson deps "$DEPS_ARRAY" \
  --argjson events "$EVENTS_ARRAY" \
  '{
    buildId: $buildId,
    libraryKey: $libraryKey,
    cdnSlug: $cdnSlug,
    topLevel: $topLevel,
    startedAt: $startAt,
    endedAt: $endAt,
    durationSec: $durationSec,
    crossCompilePath: $crossCompilePath,
    buildStatus: $buildStatus,
    bundle: { sha256: $bundleSha, byteCount: $bundleBytes, oleanCount: $oleanCount },
    validation: $validation,
    deps: $deps,
    events: $events
  }' > "$TRACE"

log INFO "manifest written to $TRACE"
log INFO "duration: ${DURATION_SEC}s, status: $BUILD_STATUS"

if [ "$BUILD_STATUS" = "success" ]; then
  exit 0
elif [ "$BUILD_STATUS" = "dry-run" ]; then
  exit 0
else
  exit 5
fi
