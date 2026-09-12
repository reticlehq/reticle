import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { scanPackage } from '../../scripts/orphan-scan.mjs';

/**
 * A module that nothing imports must be declared unwired, not discovered later as dead code.
 *
 * The last package to get this, and deliberately the last: it is the largest, and a first run
 * over fifty-nine directories is exactly the situation that produced seventeen false findings in
 * `engine`. So it was measured first, then written.
 *
 * Eleven modules have no PRODUCTION importer, and every one of them is imported by tests. That
 * splits two ways, and the split is the point of the list below:
 *
 *   **Test infrastructure living in `src/`** — `machine/temp-dir` (33 test importers), `fake-session`
 *   (11), `memory-fs` (7), `workspace-packages` (4), `import-graph` (2). Real, used constantly,
 *   and invisible to this scan because the scan deliberately ignores test importers: a module
 *   kept alive only by tests is exactly what it is looking for. These are the false positives
 *   that shape has, and naming them is cheaper than teaching the scanner about helper files.
 *
 *   **Product code whose only caller is its own test** — the other six. Each is finished,
 *   tested, and unreachable from `index.ts` or any command. That is not the same as dead: one
 *   says outright that it exists to prove a gate. But "written, proved by a test, and called by
 *   nothing" is a state worth being able to see, and until now this package could not show it.
 *
 * The list is the finding. It is not a backlog this file is asking anybody to clear, and
 * shortening it by deleting working code would be the wrong reading.
 */

const PACKAGE_DIR = join(__dirname, '..');

/** Modules with no production importer, each with the reason it is allowed to stay. */
const DECLARED_UNWIRED: Record<string, string> = {
  // ── test infrastructure that happens to live in src/ ────────────────────────────────────────
  'machine/temp-dir.ts': 'test helper: makes and removes scratch directories. 33 test importers.',
  'connection/session/fake-session.ts':
    'the typed Session double every connection test builds on. 11 test importers, and the ' +
    'reason those tests cannot silently drift from the real interface.',
  'features/project/memory-fs.ts':
    'an in-memory FileSystemPort, so a test can exercise project code without touching disk.',
  /*
   * Built and not yet driven. The port breaks a driven page's request and clears it again, and
   * `WebRealm.mutate` passes through to it — but nothing yet RUNS the loop that gives the grade its
   * meaning: replay a flow, break the thing it watches, replay it again, and demote it if it stayed
   * green.
   *
   * Deliberately not wired to anything that would run it by accident. A mutation is a real break on
   * a real page, and the loop has to reverse every one of them even when a replay throws in the
   * middle — a half-run that leaves a page permanently answering 500 hands the next flow a subject
   * that is not the subject, and every verdict after it would be about the wrong app.
   */
  'connection/input/network-mutation.ts':
    'the deliberate-break port: proven, and waiting on a caller — see mutation-run.ts.',
  /*
   * The loop is built and nothing invokes it, because invoking it is a TOOL and a tool is its own
   * change: a name on the surface, the eleven allowlists, a schema, and the battery.
   *
   * What it needs from a caller is specific, and is the reason this is not a two-line wiring: a
   * DRIVEN session (an attached tab cannot be perturbed), the flow to replay, and a target worth
   * breaking — the endpoint the flow's own steps depend on. Guessing that target is the part that
   * would quietly make the number meaningless: break something the flow never touches and every
   * flow "survives", which reads as a suite full of bad tests and is a bug in the mutation set.
   */
  'features/flows/mutation-run.ts':
    'replay/break/replay/grade, with the reversal guaranteed: proven, and waiting on the tool that ' +
    'chooses what to break.',
  'workspace-packages.ts': 'reads the workspace layout; used by the cross-package guards.',
  'import-graph.ts': 'builds the import graph the boundary guards assert over.',

  // ── product code with no production caller ──────────────────────────────────────────────────
  'features/ee/audit-log.ts':
    'deliberately unwired, and says so in its own header: an example enterprise feature whose ' +
    'body is a stub, existing to prove the licence gate rather than to be called.',
  'agent/capsule/minimize.ts':
    'a first cut at bug-capsule minimization (prefix-trim). Written and tested; nothing calls ' +
    'it yet, because the capsule pipeline it belongs to is not assembled.',
  'features/flows/flow-report.ts':
    'renders the human confidence report for a replayed flow. Complete and unreferenced: no ' +
    'tool or command currently offers it.',
  'features/phenomena/phenomena.ts':
    'named, evidence-backed anomalies over the journal. Its own header describes matchers that ' +
    'land when a later signal exists, so it is staged ahead of its caller.',
  'command/dev/stale-issue-guard.ts':
    'the decision logic behind `pnpm check:stale-issues`, which loads it from `dist` in a plain ' +
    '.mjs, so no import in `src` points at it and this scanner cannot see the caller. This ' +
    'entry used to say nothing invoked it, "not a package script, not a workflow". A package ' +
    'script did, and was crashing on the way: the module moved into `command/` and the ' +
    "script's require kept the old path. Guarded now by the dist-require check in " +
    'guards/harness/script-paths-exist.test.ts.',
};

describe('no undeclared orphan modules', () => {
  const { orphans, stale } = scanPackage(PACKAGE_DIR, DECLARED_UNWIRED);

  it('every module without a production importer is declared, with a reason', () => {
    expect(orphans).toEqual([]);
  });

  it('every declared entry is still an orphan — a wired one must be removed from the list', () => {
    // The half that keeps the list honest as the code moves. Wiring one of these up without
    // removing its line would leave a reason that is no longer true sitting in the file.
    expect(stale).toEqual([]);
  });
});
