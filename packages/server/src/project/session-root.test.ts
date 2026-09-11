import { describe, expect, it } from 'vitest';
import { ArtifactRootReason } from './artifact-root.js';
import { sessionRoot } from './session-root.js';
import type { ToolDeps } from '../tools/tool-kit.js';
import type { Session, SessionManager } from '../session/session.js';

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
          artifactRootFor: (projectId: string | undefined) =>
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
