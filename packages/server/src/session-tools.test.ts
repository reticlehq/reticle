import { describe, expect, it } from 'vitest';
import { IrisCommand, type CommandResult } from '@syrin/iris-protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';
import type { Session, SessionManager } from './session.js';

/** A session that echoes the SESSION_CONFIG args back (what the browser presenter would apply). */
function configEchoSession(): { session: Session; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const stub: Partial<Session> = {
    id: 'demo',
    command: (name, args = {}) => {
      if (name === IrisCommand.SESSION_CONFIG) sent.push(args);
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { applied: true, idleEndMs: args['idleEndMs'] },
      } as CommandResult);
    },
  };
  return { session: stub as Session, sent };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('iris_session tool', () => {
  it('forwards idleEndMs to the browser as a SESSION_CONFIG command', async () => {
    const { session, sent } = configEchoSession();
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const deps = { sessions: sessions as SessionManager } as ToolDeps;

    const r = (await tool(IrisTool.SESSION).handler(deps, { idleEndMs: 600000 })) as {
      applied: boolean;
      idleEndMs: number;
    };
    expect(sent).toEqual([{ idleEndMs: 600000 }]);
    expect(r.applied).toBe(true);
    expect(r.idleEndMs).toBe(600000);
  });
});
