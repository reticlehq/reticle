import { describe, expect, it } from 'vitest';
import { ReticleCommand, type CommandResult } from '@reticle/protocol';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import type { Session, SessionManager } from './session.js';

/** A session that echoes the SESSION_CONFIG args back (what the browser presenter would apply). */
function configEchoSession(): {
  session: Session;
  sent: Record<string, unknown>[];
  serverIdleEndMs: number[];
} {
  const sent: Record<string, unknown>[] = [];
  const serverIdleEndMs: number[] = [];
  const stub: Partial<Session> = {
    id: 'demo',
    setIdleEndMs: (ms: number) => {
      serverIdleEndMs.push(ms);
    },
    command: (name, args = {}) => {
      if (name === ReticleCommand.SESSION_CONFIG) sent.push(args);
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { applied: true, idleEndMs: args['idleEndMs'] },
      } as CommandResult);
    },
  };
  return { session: stub as Session, sent, serverIdleEndMs };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('reticle_session tool', () => {
  it('forwards idleEndMs to the browser AND tunes the server reaper', async () => {
    const { session, sent, serverIdleEndMs } = configEchoSession();
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const deps = { sessions: sessions as SessionManager } as ToolDeps;

    const r = (await tool(ReticleTool.SESSION).handler(deps, { idleEndMs: 600000 })) as {
      applied: boolean;
      idleEndMs: number;
    };
    expect(sent).toEqual([{ idleEndMs: 600000 }]);
    expect(serverIdleEndMs).toEqual([600000]); // reaper window updated server-side too
    expect(r.applied).toBe(true);
    expect(r.idleEndMs).toBe(600000);
  });

  it('does not tune the server window when idleEndMs is omitted', async () => {
    const { session, serverIdleEndMs } = configEchoSession();
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const deps = { sessions: sessions as SessionManager } as ToolDeps;

    await tool(ReticleTool.SESSION).handler(deps, {});
    expect(serverIdleEndMs).toEqual([]);
  });
});
