import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Which `.reticle` an artifact is written to is decided per CALL SITE, and forgetting one is silent.
 *
 * `deps.reticleRoot` is where the DAEMON was launched — for a user-scoped MCP registration, the
 * editor's cwd, which is usually not the app being verified. The correct address comes from the
 * session: `sessionRoot()`, `rootForProjectId()`, `flowsForSession()`, `projectForRoot()`, or
 * `session.artifactRoot`. Every one of those has existed since the daemon
 * first learned to serve more than one project. The defect is not that the
 * helper is missing; it is that callers were migrated ONE AT A TIME, and every straggler wrote a
 * user's data into a repository they never instrumented — silently, because a write to the wrong
 * tree succeeds.
 *
 * The named incidents, from this repo's own history (`git log -S`):
 *
 *   4c711c97  verdicts recorded against the daemon's cwd — and then pushed to a PRODUCTION
 *             dashboard belonging to a different account than the app was linked to
 *   c49d8b79  a failed-assert capsule filed against the wrong app
 *   7d71c7b1  two clouds sharing one credential
 *   3b70c83e  flows saved to one root and replayed from another → `flow_not_found` for a flow
 *             plainly on disk; its own body named tiers, envelopes, flakes and cloud config as
 *             "the same class of bug … left for a follow-up", and they were still open a month later
 *   f5d9065a  `verify_change` answering about the daemon's project, not the session's
 *   8ee2c2b7  `reticle verify` resolving cloud credentials from the environment while every other
 *             push path used the project's link file
 *   #— the report this file was written for: `.reticle/` reappearing in a user's BACKEND directory,
 *      carrying a session journal — URLs, request and response bodies, DOM text from their app —
 *      into a repository nobody had instrumented, with no ignore file covering it
 *
 * `memory-tools.ts` says it plainly: "The same defect has now been fixed three times in this
 * codebase; routing through sessionRoot is what stops a fourth." It did not, because nothing
 * enforced it. This is that enforcement, and it is a PIN rather than a rule: every remaining use of
 * `deps.reticleRoot` is listed below with the reason it is correct, so a new one cannot land
 * without a human deciding which root it belongs to. Modelled on `tool-allowlists-complete.test.ts`,
 * which exists for the identical failure shape one layer up.
 *
 * Adding a use? Route it through the session, and if it genuinely belongs to the daemon, add the
 * file here with a sentence saying why.
 */

/** Every use of the daemon's own root that is DELIBERATE, with the count pinned and the reason. */
const DELIBERATE: Readonly<Record<string, { uses: number; why: string }>> = {
  'wire-journal.ts': {
    uses: 3,
    why: 'The daemon wiring itself: it builds the resolver from its own root and prunes its own tree. Per-session routing happens inside the handlers it registers. Lowered from 5 when the three inline prune calls became one workspace sweep — the daemon now names its own root once for maintenance instead of three times, which is the direction this roster exists to push. Split out of `index.ts` when the composition root reached the 1000-line backstop; the uses moved with the code and none were added.',
  },
  'memory/project/session-root.ts': {
    uses: 1,
    why: 'The resolver. Its whole job is to answer with the daemon root when no project can be named.',
  },
  'memory/project/project-for-root.ts': {
    uses: 1,
    why: 'Same: returns the daemon-bound store unchanged when the resolved root IS the daemon root.',
  },
  'language/flows/flow-store-for-session.ts': {
    uses: 2,
    why: 'Same, for flows.',
  },
  'memory/journal/attach-journal.ts': {
    uses: 1,
    why: 'Fallback for a session whose project could not be resolved — `session.artifactRoot` wins when it exists.',
  },
  'memory/journal/session-end.ts': {
    uses: 4,
    why: 'The same fallback four times — ambient map, undriven-journal drop, workspace prune, run artifact — each written as `session.artifactRoot ?? deps.reticleRoot`. The fourth is the drop of a journal for a session that served no tool call, and it has to resolve the same root for the same reason the prune beside it does: teardown acts on the workspace the SESSION wrote into, never the daemon cwd.',
  },
  'surface/tools/invoke-tool.ts': {
    uses: 2,
    why: 'Opens the impact record for the daemon (a per-root store keyed inside the recorder) and falls back when a call has no session.',
  },
  'memory/cloud/sync-daemon.ts': {
    uses: 6,
    why: 'Sync walks EVERY root it can find and treats the daemon root as one of them; the comparison at :183 exists to avoid pushing it twice.',
  },
  'features/visual/visual-tools.ts': {
    uses: 2,
    why: "Fallback beside the session's own stamped root, for a capture with no session to ask.",
  },
  'surface/tools/real-input-attempt.ts': {
    uses: 1,
    why: 'Upload trust boundary. Scoping to the daemon tree fails CLOSED — a wrong root refuses a legitimate file rather than reading one it should not.',
  },
};

/**
 * The working tree, NOT `git ls-files` — and that is deliberate, because the alternative is the
 * failure this whole file exists to prevent.
 *
 * A guard that enumerates through git is blind to a file nobody has staged yet, so running it
 * before `git add` reports success about code it never read. That shipped six unrecorded
 * cross-directory reaches through a green `pnpm verify` on this branch, which is why the shared
 * enumerator in `scripts/directory-reach.mjs` now REFUSES when it finds an untracked source file
 * rather than passing over it. This walker takes the other road to the same place: it reads what is
 * on disk, so an unstaged file is caught on the spot and there is nothing to refuse.
 *
 * Verified, not assumed: an untracked file using the daemon root was planted under `server/src` and
 * this scan named it. If you ever swap this for a git-backed listing, you must bring the refusal
 * with it, or the pin starts passing over exactly the new writer it was built to catch.
 *
 * Named `...OnDisk` for that reason. The shared enumerator is also called `sourceFiles` and answers
 * the opposite question — what git TRACKS — so two functions of one name with two meanings is the
 * kind of thing a later merge resolves by deleting the "duplicate". The name is the guard against
 * that; this comment is only the explanation.
 */
function sourceFilesOnDisk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFilesOnDisk(full, acc);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.test-harness.ts'))
      acc.push(full);
  }
  return acc;
}

/** Uses of the daemon root in CODE — a mention inside a comment is prose, not a write. */
function daemonRootUses(text: string): number {
  return (
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
      .split('deps.reticleRoot').length - 1
  );
}

/** POSIX-spelled path relative to server/src, so the roster reads the same on every platform. */
const key = (file: string): string => relative(SERVER_SRC, file).split(sep).join('/');

describe('every artifact root is a decision somebody made', () => {
  it('has no use of the daemon root that is not on the roster', () => {
    const offenders = sourceFilesOnDisk(SERVER_SRC)
      .map((file) => ({ file: key(file), uses: daemonRootUses(readFileSync(file, 'utf8')) }))
      .filter((f) => f.uses > 0 && DELIBERATE[f.file] === undefined);

    expect(
      offenders.map((o) => o.file),
      'These write to wherever the daemon was launched. Route them through the session — ' +
        'sessionRoot() / rootForProjectId() / projectForRoot() / session.artifactRoot — or, if the ' +
        'daemon really is the right tree, add the file to DELIBERATE above with the reason.',
    ).toEqual([]);
  });

  it('holds each rostered file to the number of uses it was approved for', () => {
    const drifted = Object.entries(DELIBERATE).flatMap(([file, pin]) => {
      const uses = daemonRootUses(readFileSync(join(SERVER_SRC, file), 'utf8'));
      return uses === pin.uses
        ? []
        : [`${file}: pinned ${String(pin.uses)}, found ${String(uses)}`];
    });
    expect(
      drifted,
      'A rostered file gained or lost a use. Decide which root the new one belongs to.',
    ).toEqual([]);
  });

  it('cannot pass over an empty scan', () => {
    // Vacuity guard: if the walk or the matcher breaks, the two assertions above go green over
    // nothing. The daemon root IS used deliberately in several places; finding none means the
    // scanner is broken, not that the codebase is clean.
    const total = sourceFilesOnDisk(SERVER_SRC).reduce(
      (n, file) => n + daemonRootUses(readFileSync(file, 'utf8')),
      0,
    );
    expect(total).toBeGreaterThan(10);
    expect(sourceFilesOnDisk(SERVER_SRC).length).toBeGreaterThan(200);
  });

  it('every rostered file still exists', () => {
    for (const file of Object.keys(DELIBERATE)) {
      expect(
        () => statSync(join(SERVER_SRC, file)),
        `${file} is on the roster but gone`,
      ).not.toThrow();
    }
  });
});
