/**
 * An id-less flow list says whose flows it lists when the connected tab is another project's (#2427).
 *
 * The daemon's active project was one app. The only connected tab was a lease on another app with its
 * own `.reticle.json`. With no `sessionId`, `sessions.resolve()` refuses the tab (the anti-cross-talk
 * guard), `sessionTarget` falls back to no project, and the list came from the daemon's own folder:
 * 43 flows of the other app, and nothing in the answer said so.
 */
import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, ReticleTool, asProjectId, type FlowFile } from '@reticlehq/core';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { FlowStore } from './flows.js';
import { FLOW_TOOLS } from './flow-tools.js';

const DAEMON_ROOT = '/repo/web/apps/clinic/.reticle';
const LEASE_ID = 'lease-admin-1';
const ADMIN = asProjectId('admin-7f3c');

const listTool = (() => {
  const found = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_LIST);
  if (found === undefined) {
    throw new Error('no flow_list tool');
  }
  return found;
})();

const flow = (name: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name,
  createdAt: 0,
  steps: [],
});

/** The daemon's project holds `saved`; the connected tabs are `connected`, none of them in scope. */
async function deps(connected: Partial<Session>[], inScope: Partial<Session>[]): Promise<ToolDeps> {
  const { fs } = createMemoryFs();
  const flows = new FlowStore(fs, DAEMON_ROOT, { now: () => 0 });
  await flows.saveFlow(flow('clinic-checkout'), undefined);
  const sessions: Partial<SessionManager> = {
    resolve: (sessionId?: string) => {
      const named = connected.find((s) => s.id === sessionId);
      if (named !== undefined) {
        return named as Session;
      }
      throw new Error(
        "no browser session for project 'clinic-1a2b', but 1 session(s) ARE connected",
      );
    },
    all: () => connected as Session[],
    inScope: () => inScope as Session[],
  };
  return { fs, flows, reticleRoot: DAEMON_ROOT, sessions } as unknown as ToolDeps;
}

const lease: Partial<Session> = {
  id: LEASE_ID,
  url: 'http://localhost:3005/',
  projectId: ADMIN,
};

type Listing = { flows: { name: string }[]; note?: string };

describe('an id-less flow list', () => {
  it('names the project it lists, and the tab that is connected, when no tab is in scope', async () => {
    const res = (await listTool.handler(await deps([lease], []), {})) as Listing;

    expect(res.flows.map((f) => f.name)).toEqual(['clinic-checkout']);
    expect(res.note).toContain(`the daemon's project (${DAEMON_ROOT.replace('/.reticle', '')})`);
    expect(res.note).toContain(`'${ADMIN}'`);
    expect(res.note).toContain(`sessionId '${LEASE_ID}'`);
  });

  it('adds no note when a tab of the daemon project is connected', async () => {
    const own: Partial<Session> = { id: 'own-1', url: 'http://localhost:3000/' };
    const res = (await listTool.handler(await deps([own, lease], [own]), {})) as Listing;
    expect(res.note).toBeUndefined();
  });

  it('adds no note when nothing is connected', async () => {
    const res = (await listTool.handler(await deps([], []), {})) as Listing;
    expect(res.note).toBeUndefined();
  });
});
