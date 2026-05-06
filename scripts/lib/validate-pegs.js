#!/usr/bin/env node
// Validate config/wasm-deps.json before any expensive build.
//
// Hard checks (always fatal unless explicitly overridden):
//   - libraryKey exists
//   - every dep has a 40-char hex rev (no "main", "HEAD", tags)
//   - dependsOn references resolve
//   - lean version + githash present
// Soft checks (warn unless --strict):
//   - Mathlib commit date is within +/- 90 days of Lean release date
//     (a wider window than the natural overlap, but catches obvious
//     time-travel bugs like "Mathlib commit from 2030 against Lean 4.27.0
//     released 2026-Q1")
//
// Overrides:
//   --allow-nonhash-rev    accept refs that aren't 40-char hex (tags, HEAD)
//   --allow-date-violation skip date sanity
//   --strict               turn all warnings into errors
//
// Usage:
//   node scripts/lib/validate-pegs.js <pegs.json> <library-key> [flags]
//
// Output: writes a JSON validation report to stdout. Exit 0 if all
// non-overridden checks pass; exit 1 otherwise.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function fail(msg, code = 1) { console.error('[validate-pegs] ' + msg); process.exit(code); }

const args = process.argv.slice(2);
if (args.length < 2) {
  fail('usage: validate-pegs.js <pegs.json> <library-key> [--allow-nonhash-rev] [--allow-date-violation] [--strict]', 2);
}
const [pegsPath, libraryKey] = args;
const flags = {
  allowNonhashRev: args.includes('--allow-nonhash-rev'),
  allowDateViolation: args.includes('--allow-date-violation'),
  strict: args.includes('--strict'),
};

const pegs = JSON.parse(fs.readFileSync(pegsPath, 'utf8'));
const lib = pegs.libraries?.[libraryKey];
if (!lib) fail(`library "${libraryKey}" not found. Known: ${Object.keys(pegs.libraries ?? {}).join(', ')}`);

const errors = [];
const warnings = [];

if (!pegs.lean?.version) errors.push('lean.version missing in pegs file');
if (!pegs.lean?.githash || pegs.lean.githash.length !== 40) errors.push('lean.githash must be a 40-char SHA');

const HEX40 = /^[0-9a-f]{40}$/;
for (const dep of lib.deps ?? []) {
  if (!dep.name) errors.push('dep without a name');
  if (!dep.url) errors.push(`dep "${dep.name}" missing url`);
  if (!dep.rev) errors.push(`dep "${dep.name}" missing rev`);
  else if (!HEX40.test(dep.rev) && !flags.allowNonhashRev) {
    errors.push(`dep "${dep.name}" rev="${dep.rev}" is not a 40-char hex hash; pass --allow-nonhash-rev to override`);
  }
}

for (const depKey of (lib.dependsOn ?? [])) {
  if (!pegs.libraries?.[depKey]) errors.push(`dependsOn references unknown library "${depKey}"`);
}

// Date sanity. Resolve Lean release date once (from pegs file or hardcoded
// table) and compare against each dep's commit date. We only attempt the
// check for repos we can ls-remote without auth; the comparison is best
// effort and easy to override.
const LEAN_RELEASE_DATES = pegs.lean?.releaseDates ?? {
  'v4.27.0': '2026-04-15',
};
const leanReleaseStr = LEAN_RELEASE_DATES[pegs.lean.version];
if (!leanReleaseStr) {
  warnings.push(`unknown release date for lean ${pegs.lean.version}; skipping date overlap check (add to lean.releaseDates in pegs file)`);
}
const TOLERANCE_DAYS = 90;
const depDates = {};
if (leanReleaseStr) {
  const leanDate = new Date(leanReleaseStr);
  for (const dep of lib.deps ?? []) {
    if (!HEX40.test(dep.rev)) continue;
    if (dep.url.startsWith('local://')) continue;
    let commitDateStr = dep.commitDate;
    if (!commitDateStr) {
      // Try a network-free path first: only resolve if a local clone exists.
      const cacheClone = path.join(
        path.dirname(pegsPath), '..', '.build-cache', 'wasm-deps', libraryKey, dep.name
      );
      if (fs.existsSync(path.join(cacheClone, '.git'))) {
        try {
          commitDateStr = execFileSync('git', ['-C', cacheClone, 'show', '-s', '--format=%cI', dep.rev], {
            encoding: 'utf8',
          }).trim();
        } catch (_) { /* will warn below */ }
      }
    }
    if (!commitDateStr) {
      warnings.push(`dep "${dep.name}" has no commitDate and isn't cloned; cannot verify date overlap`);
      continue;
    }
    depDates[dep.name] = commitDateStr;
    const depDate = new Date(commitDateStr);
    const diffDays = Math.abs(depDate - leanDate) / 86400000;
    if (diffDays > TOLERANCE_DAYS) {
      warnings.push(`dep "${dep.name}" commit date ${commitDateStr} is ${Math.round(diffDays)} days from Lean ${pegs.lean.version} release (${leanReleaseStr}); pass --allow-date-violation to override`);
    }
  }
}

const report = {
  libraryKey,
  leanVersion: pegs.lean.version,
  leanGithash: pegs.lean.githash,
  leanReleaseDate: leanReleaseStr ?? null,
  topLevel: lib.topLevel,
  cdnSlug: lib.cdnSlug,
  dependsOn: lib.dependsOn ?? [],
  depCount: lib.deps?.length ?? 0,
  depCommitDates: depDates,
  errors,
  warnings,
  flags,
};

console.log(JSON.stringify(report, null, 2));

const dateViolations = warnings.filter((w) => w.includes('days from Lean'));
const blocking = [
  ...errors,
  ...(flags.strict ? warnings : []),
  ...(flags.allowDateViolation ? [] : dateViolations.filter((w) => !flags.allowDateViolation)),
];
if (blocking.length) {
  console.error('[validate-pegs] ' + blocking.length + ' blocking issue(s); see report above.');
  process.exit(1);
}
process.exit(0);
