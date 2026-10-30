/**
 * An auto-saved act_and_wait flow lost the query of the page it started on.
 *
 * The tab was leased on `/?showModal=login`, Escape closed the modal and the app removed the query.
 * The saved flow had `startPath: "/"` and `requires` route `/`. Its replay started on `/`, where the
 * modal never opens, so a check that the modal is absent passed without the modal ever being there.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PredicateKind,
  RETICLE_URL_PARAM,
  ReticleCommand,
  ReticleTool,
  SessionState,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { driveFlowsFrom } from '@/memory/journal/drive-flow.js';

const LEASED = `http://localhost:5173/?showModal=login&${RETICLE_URL_PARAM.SESSION}=lease-1`;
const CLOSED = 'http://localhost:5173/';
const MODAL_GONE = { kind: PredicateKind.STATE, path: 'modal.open', equals: false };

function modalSession(): { session: Session; deps: ToolDeps } {
  let open = true;
  const stub: Partial<Session> = {
    id: 'modal',
    url: LEASED,
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    recordAction: () => 'a2',
    command: (name: string): Promise<CommandResult> => {
      if (ReticleCommand.ACT === name) {
        // Escape closes the modal, and the app takes `?showModal=login` off the URL.
        open = false;
        stub.url = CLOSED;
        return Promise.resolve({
          kind: 'command_result',
          id: 'act',
          ok: true,
          result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1 } },
        });
      }
      const result =
        ReticleCommand.STATE_READ === name
          ? { stores: { app: { modal: { open } } } }
          : ({} as unknown);
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
    },
    queryEvents: () => Promise.resolve([] as ReticleEvent[]),
    eventsSince: () => [] as ReticleEvent[],
    bufferHealth: () => ({ total: 10, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
    ambientCounts: () => ({}),
  };
  const session = stub as Session;
  const root = mkdtempSync(join(tmpdir(), 'reticle-start-query-'));
  const deps = {
    sessions: { resolve: () => session } as Partial<SessionManager> as SessionManager,
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), root, { now: () => 0 }),
    fs: createNodeFileSystem(),
    reticleRoot: root,
    now: () => 0,
  } as unknown as ToolDeps;
  return { session, deps };
}

describe('an auto-saved act_and_wait flow starts on the page the journey began on', () => {
  it("keeps the app's query after the action removed it, without Reticle's own params", async () => {
    const { deps } = modalSession();
    const act = TOOLS.find((t) => ReticleTool.ACT_AND_WAIT === t.name);
    expect(act).toBeDefined();
    await act?.handler(deps, {
      ref: 'e1',
      action: 'press',
      args: { key: 'Escape' },
      timeout_ms: 0,
      until: MODAL_GONE,
    });

    const tape = deps.recordings.takeAmbient('modal');
    const { programs } = driveFlowsFrom(tape);
    const program = programs[0];
    expect(program?.startPath).toBe('/?showModal=login');
    if (program === undefined) {
      return;
    }
    const saved = await deps.flows.saveJourney(program, undefined, 'drive-');
    expect(saved.ok ? undefined : saved.code).toBeUndefined();
    const loaded = await deps.flows.load(program.name);
    const flow = loaded.ok ? loaded.value : undefined;
    expect(flow?.startPath).toBe('/?showModal=login');
    expect(flow?.requires).toEqual([{ kind: PredicateKind.ROUTE, pathname: '/?showModal=login' }]);
  });
});
