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

function deps(options: { projectId?: string; resolveThrows?: boolean; wired?: boolean }): ToolDeps {
  const session = { id: 'demo', projectId: options.projectId } as Partial<Session>;
  const sessions: Partial<SessionManager> = {
    resolve: () => {
      if (true === options.resolveThrows) throw new Error('no browser session connected');
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

  it('falls back to the daemon root when the project is unknown', () => {
    expect(sessionRoot(deps({ projectId: 'stranger-000' }), undefined)).toBe(DAEMON_ROOT);
  });

  it('falls back when the session declares no project', () => {
    expect(sessionRoot(deps({}), undefined)).toBe(DAEMON_ROOT);
  });

  /**
   * `sessions.resolve` throws for three different reasons — nothing connected, an id that names no
   * session, several connected and none named. All three mean "cannot tell which project", and none
   * is a reason to fail the caller's tool, which may not need a session at all.
   */
  it('falls back rather than throwing when no session can be resolved', () => {
    expect(sessionRoot(deps({ resolveThrows: true }), undefined)).toBe(DAEMON_ROOT);
    expect(sessionRoot(deps({ resolveThrows: true }), 'some-id')).toBe(DAEMON_ROOT);
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
