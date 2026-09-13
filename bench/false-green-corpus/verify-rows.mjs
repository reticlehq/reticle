#!/usr/bin/env node
// Re-derive every row in the third-party false-green corpus (#130 item 3, ground-truth half).
//
// A row claims something falsifiable: at `brokenRef` the upstream oracle FAILS, at `fixedRef` it
// PASSES, and the failures are the specific assertions named in the row. This runs that claim.
//
// Why it has to be re-runnable rather than measured once and written down: this repo has been
// burned by exactly that. The published benchmark figures were recorded on one date, 615 commits
// touched the harness and the fixture app, and when they were finally re-derived the detection
// numbers had moved and the per-bug output figure had INVERTED. A benchmark nobody re-derives is a
// claim, not a measurement.
//
// The rows here are pinned to immutable upstream refs, so unlike that case they cannot drift on
// their own — but the recipe around them can: a package manager changes, a lockfile resolves
// differently, a transitive dep breaks an old checkout. This tells you that happened, instead of
// letting a row quietly stop meaning what it says.
//
// `--boot` additionally proves the row's app SERVES, which is the precondition for scoring Reticle
// against it. A row whose oracle discriminates but whose app cannot be booted is ground truth with
// nothing to drive, and finding that out at scoring time is finding it out too late.
//
// Usage:
//   node bench/false-green-corpus/verify-rows.mjs [--row <id>] [--work <dir>] [--boot]
//
// Network and disk heavy by nature: it clones and installs somebody else's project. Not part of any
// gate that runs per-commit; this is a release-time check, or one you run when adding a row.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(readFileSync(join(HERE, 'rows.json'), 'utf8'));

const args = process.argv.slice(2);
const only = args.includes('--row') ? args[args.indexOf('--row') + 1] : undefined;
const withBoot = args.includes('--boot');
const work = args.includes('--work')
  ? args[args.indexOf('--work') + 1]
  : join(tmpdir(), 'reticle-false-green-corpus');

const run = (cmd, cwd, allowFailure = false) => {
  try {
    return {
      ok: true,
      out: execFileSync('bash', ['-lc', cmd], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    };
  } catch (error) {
    if (!allowFailure) throw error;
    return { ok: false, out: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}` };
  }
};

/** Count the assertions the oracle reported as failing, from a vitest-style summary line. */
function failureCount(output) {
  const m = /Tests\s+(\d+)\s+failed/.exec(output);
  return m === null ? 0 : Number(m[1]);
}

mkdirSync(work, { recursive: true });
let bad = 0;

for (const row of CORPUS.rows) {
  if (only !== undefined && row.id !== only) continue;
  console.log(`\n=== ${row.id} — ${row.subject}`);
  const dir = join(work, row.id);
  if (!existsSync(dir)) {
    console.log(`   cloning ${row.upstream}`);
    run(`git clone --filter=blob:none ${row.upstream} ${JSON.stringify(dir)}`, work);
  }

  // FIXED first: if the oracle cannot pass here, the recipe is broken and the broken-ref result
  // below would be meaningless — a red that proves nothing about the defect.
  run(`git checkout -q ${row.fixedRef} && git checkout -q ${row.fixedRef} -- .`, dir);
  run(row.oracle.install, dir);
  const pkg = join(dir, row.oracle.package);
  const fixed = run(row.oracle.command, pkg, true);
  if (!fixed.ok) {
    console.log(`   ❌ oracle FAILED at fixedRef — the recipe is broken, not the app`);
    bad += 1;
    continue;
  }
  console.log('   ✅ fixedRef: oracle passes');

  // The oracle is the fix's test applied to the BROKEN source: their assertion about their bug.
  run(`git checkout -q ${row.brokenRef} -- ${row.oracle.brokenSource.join(' ')}`, dir);
  const broken = run(row.oracle.command, pkg, true);
  const failures = failureCount(broken.out);
  const expected = row.verified.failing.length;
  if (broken.ok) {
    console.log('   ❌ brokenRef: oracle PASSED — this row no longer demonstrates a defect');
    bad += 1;
  } else if (failures !== expected) {
    // A coarse oracle going red for any reason would make every row look like a catch, so the
    // COUNT is asserted, not merely the redness.
    console.log(`   ❌ brokenRef: ${String(failures)} failed, row claims ${String(expected)}`);
    bad += 1;
  } else {
    console.log(`   ✅ brokenRef: exactly ${String(expected)} failed, as recorded`);
  }

  if (!withBoot || row.boot === undefined) continue;
  // The app must SERVE at the broken ref — that is the state Reticle would be scored against, and
  // it is the half a row can fail independently of its oracle.
  const bootCwd = join(dir, row.boot.cwd);
  const cmd = row.boot.command.replace('{port}', String(row.boot.port));
  const child = spawn('bash', ['-lc', cmd], { cwd: bootCwd, detached: true, stdio: 'ignore' });
  try {
    let served = false;
    for (let i = 0; i < 60 && !served; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      served = await fetch(row.boot.url)
        .then((r) => r.ok)
        .catch(() => false);
    }
    if (served) {
      // SERVING IS NOT RENDERING, and the difference is the whole point of this corpus.
      //
      // Measured on this row, and the correction is the lesson. A boot check that stops at the
      // status code would call a row drivable on the strength of a server answering, and a score
      // taken against a page that never mounted is a false green inside the instrument built to
      // measure false greens. But the first version of this comment asserted the opposite error:
      // it recorded that nuclear renders NOTHING without its Tauri backend, on the strength of a
      // `nodes: 0` snapshot taken before React had mounted. The app renders 1867 characters.
      // Serving, rendering and being-ready-to-drive are three properties, and each needs measuring
      // rather than inferring from the one next to it.
      // Whether the app MOUNTS is a browser question, and the served HTML cannot answer it: a Vite
      // dev server always ships an empty `#root` and fills it from JS. Inferring "renders nothing"
      // from an empty root is exactly the overclaim this probe made once — it recorded
      // `renders: false` for an app that renders 1867 characters, because the reading was taken
      // before React mounted. `renders` on the row carries the browser measurement instead.
      console.log(`   ✅ boot: serves at ${row.boot.url} on the broken ref`);
      if (row.boot.renders === true) {
        console.log('   ✅ renders: measured in a browser');
      } else if (row.boot.renders === false) {
        console.log(
          `   ⚠  renders: NO — oracle verifiable, not drivable. ${row.boot.rendersNote ?? ''}`,
        );
      } else {
        console.log('   ⚠  renders: UNMEASURED — do not score this row until it is');
      }
    } else {
      console.log(`   ❌ boot: never served at ${row.boot.url} — nothing to drive Reticle against`);
      bad += 1;
    }
  } finally {
    // Negative pid kills the group: a detached vite orphans its child and holds the port for the
    // life of the machine otherwise, which makes the NEXT run fail for a reason that is not its own.
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

console.log(bad === 0 ? '\n✅ every row re-derived' : `\n❌ ${String(bad)} row(s) no longer hold`);
process.exit(bad === 0 ? 0 : 1);
