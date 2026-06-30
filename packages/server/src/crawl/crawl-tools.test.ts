import { describe, expect, it } from 'vitest';
import {
  CrawlAnomalyKind,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticle/protocol';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import type { CrawlReport } from './crawl.js';
import type { Session, SessionManager } from '../session/session.js';

/** Scripted session: one interactive control whose click does nothing (a dead control). */
function deadButtonSession(): Session {
  let clock = 0;
  const buffer: ReticleEvent[] = [];
  const ok = (result: unknown): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:3000/',
    elapsed: () => clock,
    eventsSince: (since) => buffer.filter((e) => e.t > since),
    command: (name) => {
      if (name === ReticleCommand.SNAPSHOT) return ok({ tree: 'button "Dead" (ref=e1)' });
      if (name === ReticleCommand.ACT) {
        clock += 1;
        return ok({ dispatched: true });
      }
      return ok({});
    },
  };
  return stub as Session;
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('reticle_crawl tool', () => {
  it('drives the resolved session and returns a structured anomaly report', async () => {
    const session = deadButtonSession();
    const sessions: Partial<SessionManager> = { resolve: () => session };
    const deps = { sessions: sessions as SessionManager } as ToolDeps;

    const r = (await tool(ReticleTool.CRAWL).handler(deps, { settleMs: 0 })) as CrawlReport;
    expect(r.interactiveFound).toBe(1);
    expect(r.stepsRun).toBe(1);
    expect(r.counts.deadControls).toBe(1);
    expect(r.anomalies[0]?.kind).toBe(CrawlAnomalyKind.DEAD_CONTROL);
  });
});
