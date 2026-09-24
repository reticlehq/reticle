/**
 * A capsule is filed against the codebase that produced the failure.
 *
 * Found by driving Persona 5 with the impact fix already in: the ledgers separated correctly and
 * the capsule did not. A failing assertion on an app in repo B wrote its capsule into repo A —
 * the daemon's own root — where it names B's source file (`ui/global-nav.tsx:62`) inside a
 * checkout that has no such file.
 *
 * That is worse than a miscount, because a capsule outlives the turn: it becomes a regression flow
 * the moment it goes green, so the wrong repo inherits a test for somebody else's bug.
 */
import { describe, expect, it, vi } from 'vitest';
import { join, sep } from 'node:path';
import { saveFailedAssertCapsule } from './act-capsule.js';
import type { ToolDeps } from './tool-kit.js';

// Host-native, because the assertions below are `startsWith` over paths the callee builds with
// `path.join`. A literal '/daemon/.reticle' makes every one of them fail on Windows for a reason
// that has nothing to do with which root won — which is the only thing this file is about.
const DAEMON_ROOT = join(sep, 'daemon', '.reticle');
const HER_ROOT = join(sep, 'her-app', '.reticle');

/**
 * Deps whose session resolves to HER project, with an fs that records where writes landed.
 *
 * `artifactRootFor` is the same seam nine other modules use; `sessionRoot` consults it via the
 * session's projectId, so wiring it here is what the real daemon does.
 */
function depsWritingTo(): { deps: ToolDeps; written: string[] } {
  const written: string[] = [];
  const fs = {
    mkdir: () => Promise.resolve(),
    writeFile: (path: string) => {
      written.push(path);
      return Promise.resolve();
    },
    readFile: () => Promise.reject(new Error('missing')),
    exists: () => Promise.resolve(false),
    readdir: () => Promise.resolve([]),
    rm: () => Promise.resolve(),
  };
  const deps = {
    fs,
    reticleRoot: DAEMON_ROOT,
    now: () => 1_000,
    sessions: { resolve: () => ({ projectId: 'her-app' }) },
    artifactRootFor: (projectId: string | undefined) =>
      'her-app' === projectId
        ? { root: HER_ROOT, reason: 'matched-project' }
        : { root: DAEMON_ROOT, reason: 'no-match' },
  } as unknown as ToolDeps;
  return { deps, written };
}

/**
 * Deps whose `sessions.resolve` refuses however it is called, with no resolver wired.
 *
 * `resolve` throws for three reasons — nothing connected, an id that names no session, several
 * connected and none named — and the caller's own arguments are what tell them apart.
 */
function depsFailingToResolve(): { deps: ToolDeps; written: string[] } {
  const written: string[] = [];
  const deps = {
    fs: {
      mkdir: () => Promise.resolve(),
      writeFile: (path: string) => {
        written.push(path);
        return Promise.resolve();
      },
      readFile: () => Promise.reject(new Error('missing')),
      exists: () => Promise.resolve(false),
      readdir: () => Promise.resolve([]),
      rm: () => Promise.resolve(),
    },
    reticleRoot: DAEMON_ROOT,
    now: () => 1_000,
    sessions: {
      resolve: () => {
        throw new Error('no session');
      },
    },
  } as unknown as ToolDeps;
  return { deps, written };
}

const failing = {
  verdict: { pass: false, failureReason: 'expected no error entries but found 1' },
  capsule: { summary: {}, firstDivergence: null, blastRadius: [] } as never,
  links: [],
  args: { sessionId: 'her-session', ref: 'e44', action: 'click' },
  actResult: { result: { testid: 'nav' } },
};

describe('where a failed-assert capsule is filed', () => {
  it('uses the root the CALLER resolved — the session the act actually drove', async () => {
    // The case the first version of this fix got wrong, caught by driving rather than by a test:
    // re-resolving from `args.sessionId` fails when the arg is absent AND more than one tab is
    // connected, because `sessions.resolve(undefined)` throws when it cannot choose. That is the
    // multi-project case, i.e. exactly the situation the routing exists for. The caller holds the
    // session it drove (including one followed through a navigation), so it passes the answer.
    const written: string[] = [];
    const deps = {
      fs: {
        mkdir: () => Promise.resolve(),
        writeFile: (path: string) => {
          written.push(path);
          return Promise.resolve();
        },
        readFile: () => Promise.reject(new Error('missing')),
        exists: () => Promise.resolve(false),
        readdir: () => Promise.resolve([]),
        rm: () => Promise.resolve(),
      },
      reticleRoot: DAEMON_ROOT,
      now: () => 1_000,
      // Ambiguous on purpose: two tabs connected, no id given.
      sessions: {
        resolve: () => {
          throw new Error('several sessions connected and none was named');
        },
      },
    } as unknown as ToolDeps;

    await saveFailedAssertCapsule({ deps, ...failing, args: {}, root: HER_ROOT });

    expect(written.every((p) => p.startsWith(HER_ROOT))).toBe(true);
    expect(written.some((p) => p.startsWith(DAEMON_ROOT))).toBe(false);
  });

  it("writes into the failing app's OWN .reticle, not the daemon's", async () => {
    const { deps, written } = depsWritingTo();

    await saveFailedAssertCapsule({ deps, ...failing });

    expect(written.length).toBeGreaterThan(0);
    // Assert the inverse too: before the fix every path here began with the daemon root, and a
    // test that only checked "something was written" would have passed throughout.
    expect(written.every((p) => p.startsWith(HER_ROOT))).toBe(true);
    expect(written.some((p) => p.startsWith(DAEMON_ROOT))).toBe(false);
  });

  /*
   * A capsule filename says what the file is ABOUT, never what a ref happened to be called.
   *
   * The label came from `args.ref` - a volatile element handle like `e44`, minted per session and
   * meaningless an hour later or anywhere else. That went into the filename of an artifact that is
   * durable, meant to be committed, and read by somebody who was not there. The testid on the anchor
   * is the same element said in a name a human chose, and it is already computed for the capsule
   * body a few lines above.
   */
  it('names a capsule after the element, not the ref that addressed it', async () => {
    const { deps, written } = depsWritingTo();

    await saveFailedAssertCapsule({ deps, ...failing });

    const name = written[0]?.split('/').pop() ?? '';
    expect(name).toContain('nav');
    expect(name).not.toContain('e44');
  });

  /* No testid: the action is still stable and still says something. The ref never is. */
  it('falls back to the action rather than the ref', async () => {
    const { deps, written } = depsWritingTo();

    await saveFailedAssertCapsule({
      ...{ deps, ...failing },
      actResult: { result: {} },
    });

    const name = written[0]?.split('/').pop() ?? '';
    expect(name).toContain('click');
    expect(name).not.toContain('e44');
  });

  it('falls back to the daemon root when no project can be named', async () => {
    const { deps, written } = depsFailingToResolve();

    // No sessionId: nothing was named, so nothing was mis-addressed and the daemon root is the
    // honest fallback. The id-bearing half of this case is the test below, and it answers
    // differently — which is why the two are stated apart rather than sharing `failing.args`.
    await saveFailedAssertCapsule({ deps, ...failing, args: { ref: 'e44', action: 'click' } });

    // Non-vacuity first: `every` over an empty list is true, so without this the assertion below
    // would keep passing for a capsule that was never filed anywhere.
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((p) => p.startsWith(DAEMON_ROOT))).toBe(true);
  });

  /**
   * A named session that resolves to nothing files NO capsule, rather than one in the daemon's own
   * checkout (#994) — and rather than throwing, which would turn a red assertion into a tool error
   * and lose the verdict that found the bug. Both halves are asserted, because either one alone
   * would pass for a broken version of the other.
   */
  it('files nothing, and fails nothing, when the named session resolves to nothing', async () => {
    const { deps, written } = depsFailingToResolve();

    const id = await saveFailedAssertCapsule({ deps, ...failing });

    expect(id).toBeUndefined();
    expect(written).toEqual([]);
  });

  it('writes nothing for a passing verdict', async () => {
    const { deps, written } = depsWritingTo();

    const id = await saveFailedAssertCapsule({ ...failing, deps, verdict: { pass: true } });

    expect(id).toBeUndefined();
    expect(written).toEqual([]);
  });

  it('never lets a failed write break the run that found the bug', async () => {
    // Capturing evidence is best-effort by design: the assertion already failed, and losing the
    // capsule must not also lose the verdict.
    const deps = {
      fs: {
        mkdir: () => Promise.reject(new Error('disk full')),
        writeFile: vi.fn(),
        readFile: () => Promise.reject(new Error('missing')),
        exists: () => Promise.resolve(false),
        readdir: () => Promise.resolve([]),
        rm: () => Promise.resolve(),
      },
      reticleRoot: DAEMON_ROOT,
      now: () => 1_000,
      sessions: { resolve: () => ({ projectId: 'her-app' }) },
      artifactRootFor: () => ({ root: HER_ROOT, reason: 'matched-project' }),
    } as unknown as ToolDeps;

    await expect(saveFailedAssertCapsule({ deps, ...failing })).resolves.not.toThrow();
  });
});
