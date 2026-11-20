/**
 * A verdict never grades a guessed tab.
 *
 * Reported from the field: with two tabs connected, `reticle_assert` named no `sessionId`, the
 * resolver auto-picked the other tab (route `/`), and the answer was `verified: "no"` about a page
 * the agent never meant. `narrate`, called a moment earlier, had refused as ambiguous: the same
 * resolver, a different moment, a different heartbeat order. A guessed "no" is a false verdict.
 *
 * So when more than one tab is connected, a verdict tool that names no session refuses and lists
 * the tabs. A tool that only drives or reads (a single `act`, a `snapshot`) keeps the auto-pick.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool, type CommandResult } from '@reticlehq/core';
import { createFakeSession } from '@/portal/session/fake-session.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import type { ToolDef, ToolDeps } from './tools.js';
import { runTool } from './invoke-tool.js';

const ROOT = '/tmp/reticle-verdict-guessed-tab/.reticle';
const MEANT = 'tab-meant';
const OTHER = 'tab-other';

function tab(id: string): Session {
  return createFakeSession(
    {
      command: (): Promise<CommandResult> =>
        Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} }),
      lastSeenMs: () => 0,
      health: () => ({ lastSeenMs: 0, throttled: false, focused: false }),
      bufferHealth: () => ({ total: 0, dropped: 0 }),
    },
    { sessionId: id, url: `http://localhost:5173/${id}` },
  );
}

/** Two connected tabs; an omitted `sessionId` resolves to OTHER, the tab the agent did not mean. */
function depsWith(tabs: Session[]): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: (id?: string) => {
      const found = id === undefined ? tabs.at(-1) : tabs.find((s) => s.id === id);
      if (found === undefined) {
        throw new Error(`no connected session with id '${String(id)}'`);
      }
      return found;
    },
    list: () =>
      tabs.map((s) => ({ sessionId: s.id, url: s.url })) as ReturnType<SessionManager['list']>,
  };
  const fs = createNodeFileSystem();
  const now = (): number => 0;
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now }),
    project: new ProjectStore(fs, ROOT, { now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now,
  };
}

/** A tool under a real name whose handler records which tab it was handed. */
function spy(name: string, ran: unknown[]): ToolDef {
  return {
    name,
    description: '',
    inputSchema: {},
    handler: (_deps, args) => {
      ran.push(args['sessionId']);
      return Promise.resolve({ verified: 'no' });
    },
  };
}

const twoTabs = (): ToolDeps => depsWith([tab(MEANT), tab(OTHER)]);

describe('a verdict tool with two tabs connected and no sessionId', () => {
  it('refuses, names both tabs, and grades nothing', async () => {
    const ran: unknown[] = [];
    const call = runTool(spy(ReticleTool.ASSERT, ran), twoTabs(), {});
    await expect(call).rejects.toThrow(/^multiple sessions connected/);
    await expect(call).rejects.toThrow(new RegExp(`${MEANT}.*${OTHER}|${OTHER}.*${MEANT}`));
    expect(ran, 'the handler graded a tab nobody named').toEqual([]);
  });

  it('refuses an act that carries steps, which is a verdict', async () => {
    const ran: unknown[] = [];
    await expect(
      runTool(spy(ReticleTool.ACT, ran), twoTabs(), { steps: [{ action: 'click', ref: 'e1' }] }),
    ).rejects.toThrow(/^multiple sessions connected/);
    expect(ran).toEqual([]);
  });

  it('runs when the call names the tab', async () => {
    const ran: unknown[] = [];
    await runTool(spy(ReticleTool.ASSERT, ran), twoTabs(), { sessionId: MEANT });
    expect(ran).toEqual([MEANT]);
  });

  it('keeps the auto-pick for a single act, which grades nothing', async () => {
    const ran: unknown[] = [];
    await runTool(spy(ReticleTool.ACT, ran), twoTabs(), { action: 'click', ref: 'e1' });
    expect(ran).toEqual([OTHER]);
  });

  it('keeps the auto-pick when only one tab is connected', async () => {
    const ran: unknown[] = [];
    await runTool(spy(ReticleTool.ASSERT, ran), depsWith([tab(MEANT)]), {});
    expect(ran).toEqual([MEANT]);
  });
});
