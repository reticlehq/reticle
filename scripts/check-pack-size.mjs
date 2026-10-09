#!/usr/bin/env node
// The unpacked size of the two published packages a size change is felt in, against a ceiling.
//
// ONE implementation, run by `.github/workflows/package-quality.yml` and by hand
// (`pnpm build && pnpm check:pack-size`). It used to live only in that workflow, which no local
// gate runs, so #1493 learned it had blown the server budget (6,608,861 > 6,600,000) from CI after
// every local gate was green. Needs a built tree: `npm pack` runs each package's prepack.
//
// THE CONVENTION FROM HERE ON: a ceiling is the last measurement plus HEADROOM_BYTES. When a change
// goes over, raise it BY the headroom (new measurement + 100 KB), never TO the measurement, and
// write the reason beside the number. A ceiling pinned just over the measurement makes the next
// two PRs that add bytes both edit the same constant and conflict in the merge queue.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADROOM_BYTES = 100_000;

/*
 * The browser SDK is embedded in users' apps — guard its own dist from ballooning. This is the
 * package's shipped code (source maps included), NOT the bundled+deps figure; for that, add
 * size-limit later.
 *
 * 950KB was raised from 900KB in 2.9.0, and only AFTER taking the waste out rather than to
 * paper over it: the artwork, the icon set and the HUD's style strings were each being
 * copied a second time into the emitted .d.ts as literal types — 19.6KB of type information
 * no caller can use — and annotating them `: string` gave that back.
 *
 * 1000KB in 2.13.0, on the same terms. The waste came out first: MCP_DOCS_URL,
 * HUD_DRAG_IGNORE_SEL and HUD_LOG_WELL_CSS had reacquired exactly the defect above and were
 * annotated, which returned ~1.3KB. What remained is code somebody chose to ship, and the
 * release names it:
 *
 *   - registry/auto-testids.ts, new
 *   - registry/capabilities.ts, extended
 *   - the HUD's unreachable state — an instrumented page whose bridge never answered used to
 *     be indistinguishable from a page with no Reticle in it
 *   - desktop capture for the Electron and Tauri shells
 *
 * MEASURED 2026-09-11: 660,466 bytes. The paragraph above used to end "the package is
 * ~954KB after that, so this leaves ~46KB of headroom", and both halves were wrong by
 * the time anybody read them: 2.14.0's SDK reduction took the package to 556,271 bytes
 * and nobody came back to this comment. A reader planning a change believed they had
 * 46KB to spend when they had 332KB.
 *
 * The ceiling was 1,000,000, which is 45% slack, and slack is how the package grew from
 * 556,271 to 660,466 across this release without one check going red. That growth is
 * not a defect — a new protocol package, the realm registry and desktop capture all
 * landed — but it should have been a number somebody chose rather than one nobody saw.
 *
 * So the ceiling comes down to 700,000: today's measurement plus about 40KB, the same
 * shape of margin this comment has always described, and now actually true. The rule is
 * unchanged and is the reason the number moved down rather than up: a raise to make a
 * red check green is what this comment exists to prevent, so if the reason is not in
 * the diff, do not move the number.
 *
 * 700,000 -> 1,180,000 in 3.3.0, and the reason is one file: dist/reticle-inject.js, the
 * zero-install reader (472,597 bytes, the whole SDK as one minified script). The daemon
 * reads it as text and evaluates it in a leased page whose app never ran `init`, which is
 * how such a page still reaches a verdict. Without it the package measured 663,995. It
 * cannot move to the server, which sits 35KB under its own ceiling below. The follow-up
 * is a slimmer reader (no HUD), which would bring this back down; until then the margin
 * is ~40KB, on the same terms as above.
 *
 * 1,180,000 -> 1,380,000 in 3.6.0. MEASURED: 1,339,597 bytes, after the duplicate
 * single-file build came out (1,897,301 before). reticle-inject.js is 564,690 (it was
 * 472,597) and the rest is ~775KB (it was 663,995): the presenter grew across 3.4-3.6
 * (chat views, settings, controls) and the reader carries it a second time, because it
 * still bundles the HUD. The slimmer reader named above is still the follow-up, and it
 *
 * 1,380,000 -> 1,473,686 on 2026-10-09: measured 1,373,686 on main at c02824992, 6KB under the
 * old ceiling, plus HEADROOM_BYTES.
 */
const BROWSER_MAX_BYTES = 1_473_686;

/*
 * The other package a size change is felt in, and it had no ceiling at all.
 *
 * Nobody installs @reticlehq/server as a dependency; an agent runs it with `npx`, which
 * downloads it before the first tool call of a fresh machine. That download is on the
 * path this project measures in minutes-to-first-verdict, so its size is a user-facing
 * number even though no package.json mentions it.
 *
 * MEASURED 2026-09-11: 4,845,142 bytes, most of it the docs that `pack-docs.mjs` stages
 * so the MCP surface can answer from them offline. Recorded at 5,200,000, which is
 * about 350KB of room. Same rule as the SDK above: if the reason is not in the diff,
 * do not move the number.
 *
 * RAISED to 5,400,000 on 2026-09-17, with the reason, on the first CI run that ever
 * measured this branch: 5,272,323 bytes, 72KB past the ceiling. The 350KB of room was
 * spent by v3.1.0 itself — recording, flows, hooks and the tour all land in `server/dist`.
 *
 * Two contributor docs came out of the tarball in the same change and are NOT what bought
 * the headroom: `telemetry-contract.md` and `telemetry-events.mdx` are about ADDING
 * telemetry to Reticle, so they should never have shipped to somebody who installed it.
 * That is 88KB and it only got the package back under the OLD number by 9KB, which is not
 * headroom, it is a coincidence waiting to fail on the next doc edit.
 *
 * So: 5,400,000, which is ~210KB of room over the measured 5,190,356. The docs are still
 * ~1MB of this package and are the first place to look when this is next hit.
 *
 * RAISED to 5,750,000 on 2026-09-23, for v3.2.0, and the docs were NOT what moved. The
 * branch measured 5,514,235 against main's 5,184,640, and the difference was measured by
 * packing both rather than guessed at:
 *
 *     code  3,160K -> 3,386K   (+226K)
 *     types 1,106K -> 1,195K   (+89K)
 *     docs    797K ->   804K   (+7K)
 *
 * That is 315KB of compiled code and the type declarations for it -- journal bounds,
 * intent sharding, the realm registry, the harness-offer read, ProjectId branding and the
 * status surface, across 188 changed files. The rule above is that the reason must be in
 * the diff, and here it is, in the half of the package that is the product. Source maps
 * and declaration maps already do not ship, so the cheap win was taken before this.
 *
 * ~235KB of room over the measurement, matching the shape of the previous raise rather
 * than clearing today's number by a hair. The docs remain the first place to look.
 *
 * RAISED to 6,800,000 on 2026-10-09 for #1493: the branch measured 6,608,861, 9KB over.
 * That is #1492 and #1493 together: `reticle try`, the GitHub Action's results JSON,
 * start-then-poll Harness drives with stop and steer, the HUD's Run Harness, run sync
 * into the caller's project, and coverage with the coding-agent prompt. ~191KB of room,
 * the same shape as the raises below.
 *
 * RAISED to 6,600,000 on 2026-10-07, for v3.6.0: the release measured 6,413,252, 13KB
 * over, packed and broken down against the raise below:
 *
 *     code  3,886K -> 3,953K   (+67K)
 *     types 1,392K -> 1,410K   (+18K)
 *     docs    907K ->   888K   (-19K)
 *
 * The code is the daemon's half of driving from the platform's chat: reporting the apps on
 * this machine (local-apps), the chat wiring (chat-drives), a drive's target and HUD
 * (drive-target), the tool session with its retries in remote-drive, headed leases in the
 * pool, and reticle_lease's `headed` and `hud`. ~187KB of room, the same shape as the
 * raises below; the docs remain the first place to look.
 *
 * RAISED to 6,400,000 on 2026-10-05. main measured 6,197,543 -- 2.4KB under the old
 * ceiling -- against 6,017,969 at the previous raise (bfa6320ba), packed both ways:
 *
 *     code  3,767K -> 3,886K   (+119K)
 *     types 1,352K -> 1,392K   (+40K)
 *     docs    886K ->   907K   (+21K)
 *
 * No single change: 57 commits of fixes across v3.4.0 and v3.5.0 (one-command connect,
 * run sync, real key presses, replay re-resolution, lease and navigate fixes). With 2.4KB
 * left, contributors had started deleting code comments -- including safety rationale --
 * to squeeze under the line, which is the wrong trade: a comment costs bytes nobody runs.
 * ~200KB of room, the same shape as the raises below.
 *
 * RAISED to 6,200,000 on 2026-09-30 for #1202: this branch on main measured 6,017,969,
 * 68KB over. That is the exhaustive crawl, the app-wide coverage ledger with code
 * coverage from the driven browser, `act_and_wait { durable }` and `reticle gate
 * --accept-coverage`. ~182KB of room, the same shape as the raises below.
 *
 * RAISED to 5,950,000 on 2026-09-29. main measured 5,728,640 -- 21KB under the old
 * ceiling -- and the flow-fidelity branch 5,754,246, packed both ways:
 *
 *     code  3,578K -> 3,595K   (+17K)
 *     types 1,277K -> 1,284K   (+7K)
 *     docs    861K ->   862K   (+2K)
 *
 * That is resume-from-step, merging duplicate drives, step pages, flow authors and the
 * replayable run fields. ~196KB of room, the same shape as the two raises above.
 *
 * 6,800,000 -> 6,722,559 on 2026-10-09, DOWN, to the convention above: measured 6,622,559 on main
 * at c02824992, plus HEADROOM_BYTES.
 */
const SERVER_MAX_BYTES = 6_722_559;

const BUDGETS = [
  { name: '@reticlehq/browser', dir: 'adapters/realm/browser', max: BROWSER_MAX_BYTES },
  { name: '@reticlehq/server', dir: 'server', max: SERVER_MAX_BYTES },
];

/** `npm pack --dry-run --json`'s unpackedSize. prepack may print first, so parse from the array. */
function unpackedSize(dir) {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: join(ROOT, dir),
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`npm pack failed in ${dir}:\n${res.stderr}`);
  const start = res.stdout.search(/^\[/m);
  if (start < 0) throw new Error(`npm pack in ${dir} printed no JSON:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start))[0].unpackedSize;
}

let failed = false;
for (const { name, dir, max } of BUDGETS) {
  const bytes = unpackedSize(dir);
  const room = max - bytes;
  console.log(`${name} unpacked: ${bytes} bytes (ceiling ${max}, ${room} to spare)`);
  if (bytes > max) {
    failed = true;
    console.log(
      `::error::${name} unpacked size ${bytes} exceeds the ${max} budget. Find what grew, or ` +
        `raise the ceiling in scripts/check-pack-size.mjs to ${bytes + HEADROOM_BYTES} ` +
        `(measurement + headroom) with the reason written beside it.`,
    );
  }
}
process.exit(failed ? 1 : 0);
