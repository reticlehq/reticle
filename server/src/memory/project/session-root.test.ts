import { describe, expect, it } from 'vitest';
import { ArtifactRootReason } from './artifact-root.js';
import { rootForProjectId, sessionProjectId, sessionRoot } from './session-root.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { asProjectId, type ProjectId } from '@reticlehq/core';

/**
 * Does the ProjectId brand actually bite?
 *
 * `sessionRoot` and `rootForProjectId` sit two lines apart and used to take the SAME argument type,
 * so swapping them compiled — and then failed silently to the daemon root on both paths: no throw,
 * no log, the artifact written into a tree nobody drove, and the tool reporting success.
 *
 * A compile error cannot be asserted at runtime, so the assertions are the type aliases below. This
 * file only typechecks while they hold, and the test files are inside `tsc -b`. Exported so none of
 * them reads as an unused local; read off the functions rather than restated, so a signature change
 * moves the assertion with it.
 */
type Expect<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

export type ProjectIdParam = Parameters<typeof rootForProjectId>[1];
export type SessionIdParam = Parameters<typeof sessionRoot>[1];

/** CAUGHT — the dangerous direction: a plain-string sessionId cannot reach the projectId slot. */
export type SessionIdIsNotAProjectId = Expect<
  Assignable<SessionIdParam, ProjectIdParam> extends false ? true : false
>;
/** And the mint is what reopens it: a value that came from the session manager still fits. */
export type AMintedProjectIdFits = Expect<
  Assignable<ReturnType<typeof sessionProjectId>, ProjectIdParam>
>;
/**
 * NOT CAUGHT, deliberately. `ProjectId` is still a `string`, so the reverse swap compiles; closing
 * it means branding `sessionId` at every tool-call boundary where it arrives as a raw argument.
 * Pinned rather than left implicit: whoever does close it fails this line and is sent to correct
 * the brand's doc, instead of leaving a door labelled shut that is not.
 */
export type ProjectIdStillFitsASessionIdParam = Expect<Assignable<ProjectIdParam, SessionIdParam>>;

const DAEMON_ROOT = '/daemon-cwd/.reticle';
const PROJECT_ROOT = '/repo/apps/web/.reticle';
const LIVE_ID = 'live-7';
/** An id the agent still holds after the tab reconnected under a new one. Names nothing now. */
const GONE_ID = 'gone-42';

function deps(options: {
  projectId?: string;
  resolveThrows?: boolean;
  wired?: boolean;
  liveId?: string;
}): ToolDeps {
  const session = {
    id: options.liveId ?? 'demo',
    projectId: options.projectId,
  } as Partial<Session>;
  const sessions: Partial<SessionManager> = {
    /*
     * The real manager's two refusal shapes, kept apart because the fix turns on the difference.
     * `resolveThrows` is "nothing to choose from at all"; the id branch below is "you named one and
     * it is not here", which is the case that used to be answered with somebody else's directory.
     */
    resolve: (sessionId?: string) => {
      if (true === options.resolveThrows) throw new Error('no browser session connected');
      if (sessionId !== undefined && sessionId !== session.id) {
        throw new Error(`no connected session with id '${sessionId}'`);
      }
      return session as Session;
    },
  };
  return {
    sessions: sessions as SessionManager,
    reticleRoot: DAEMON_ROOT,
    ...(false === options.wired
      ? {}
      : {
          artifactRootFor: (projectId: ProjectId | undefined) =>
            'acme-9f3c' === projectId
              ? { root: PROJECT_ROOT, reason: ArtifactRootReason.MATCHED_PROJECT }
              : { root: DAEMON_ROOT, reason: ArtifactRootReason.NO_MATCH },
        }),
  } as unknown as ToolDeps;
}

describe('sessionRoot', () => {
  it('resolves to the session project', () => {
    expect(sessionRoot(deps({ projectId: 'acme-9f3c' }), undefined)).toBe(PROJECT_ROOT);
  });

  it('resolves to the session project when that session was named explicitly', () => {
    expect(sessionRoot(deps({ projectId: 'acme-9f3c', liveId: LIVE_ID }), LIVE_ID)).toBe(
      PROJECT_ROOT,
    );
  });

  it('falls back to the daemon root when the project is unknown', () => {
    expect(sessionRoot(deps({ projectId: 'stranger-000' }), undefined)).toBe(DAEMON_ROOT);
  });

  it('falls back when the session declares no project', () => {
    expect(sessionRoot(deps({}), undefined)).toBe(DAEMON_ROOT);
  });

  /**
   * `sessions.resolve` throws for three different reasons — nothing connected, an id that names no
   * session, several connected and none named. With NO id in hand the first and third mean "cannot
   * tell which project", and neither is a reason to fail a caller that may not need a session at
   * all. The second is a different fact and is asserted separately below.
   */
  it('falls back rather than throwing when no session was named and none can be resolved', () => {
    expect(sessionRoot(deps({ resolveThrows: true }), undefined)).toBe(DAEMON_ROOT);
  });

  /**
   * The wrong-project write, reported three times against 2.14.0 (#994).
   *
   * An agent that names a session has named the project too. When that id resolves to nothing the
   * old code swallowed the throw, handed `undefined` to the resolver and got the DAEMON's own
   * `.reticle` back — so `reticle_intent` wrote its ledger into whichever checkout the daemon
   * happened to be started in. That file is git-checked, and one reporter only noticed because
   * they ran `git diff`. There is no root that is right here, so there is no write either.
   */
  it('refuses a named session that resolves to nothing instead of using the daemon root', () => {
    expect(() => sessionRoot(deps({ projectId: 'acme-9f3c' }), GONE_ID)).toThrow(GONE_ID);
  });

  it('names the daemon-root hazard and the underlying cause when it refuses', () => {
    let message = '';
    try {
      sessionRoot(deps({ projectId: 'acme-9f3c' }), GONE_ID);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message, 'the refusal must say nothing was written').toMatch(
      /nothing was read or written/,
    );
    expect(message, "the manager's own diagnosis is the actionable half").toMatch(
      /no connected session with id 'gone-42'/,
    );
  });

  /**
   * Every existing construction of ToolDeps, and any consumer embedding this engine, has no
   * resolver. Those must behave exactly as they did before it existed.
   */
  it('is a no-op when no resolver is wired', () => {
    expect(sessionRoot(deps({ projectId: 'acme-9f3c', wired: false }), undefined)).toBe(
      DAEMON_ROOT,
    );
  });

  /**
   * An unwired resolver means the daemon root is the only answer available — which is exactly why
   * the refusal cannot be conditional on it. `artifactRootFor?.()` short-circuits its own argument,
   * so with no resolver the old code never even asked whether the named session existed.
   */
  it('still refuses a named session that resolves to nothing with no resolver wired', () => {
    expect(() => sessionRoot(deps({ projectId: 'acme-9f3c', wired: false }), GONE_ID)).toThrow(
      GONE_ID,
    );
  });

  /**
   * ...and costs nothing extra when there is nothing to refuse. `resolve(undefined)` is not a
   * lookup: with nothing connected it builds the ranked no-session diagnosis and records which
   * branch it took. An unwired embedder that names no session did not pay for that before and
   * must not start now, so the id is what gates the call rather than the branch.
   */
  it('does not consult the session manager at all when unwired and no session was named', () => {
    let asked = 0;
    const unwired = {
      sessions: {
        resolve: () => {
          asked += 1;
          throw new Error('no browser session connected');
        },
      },
      reticleRoot: DAEMON_ROOT,
    } as unknown as ToolDeps;

    expect(sessionRoot(unwired, undefined)).toBe(DAEMON_ROOT);
    expect(asked).toBe(0);
  });
});

describe('sessionProjectId', () => {
  it('answers the connected session project', () => {
    expect(sessionProjectId(deps({ projectId: 'acme-9f3c' }), undefined)).toBe('acme-9f3c');
  });

  it('answers undefined when no session was named and none can be resolved', () => {
    expect(sessionProjectId(deps({ resolveThrows: true }), undefined)).toBeUndefined();
  });

  /**
   * The half-address the module header warns about, in its other half. A caller that took
   * `undefined` here went on to read or write the daemon's own project id — `verify_change` scoping
   * a stranger's flows into this run's answer.
   */
  it('refuses a named session that resolves to nothing', () => {
    expect(() => sessionProjectId(deps({ projectId: 'acme-9f3c' }), GONE_ID)).toThrow(GONE_ID);
  });
});

describe('rootForProjectId', () => {
  it('routes a minted projectId to its own project', () => {
    expect(rootForProjectId(deps({ projectId: 'acme-9f3c' }), asProjectId('acme-9f3c'))).toBe(
      PROJECT_ROOT,
    );
  });

  it('still falls back to the daemon root when the id names no project — unchanged behaviour', () => {
    expect(rootForProjectId(deps({}), asProjectId('s-7f2a-not-a-project'))).toBe(DAEMON_ROOT);
  });
});
