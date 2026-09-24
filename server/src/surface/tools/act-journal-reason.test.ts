/**
 * The deciding clause reaches the journal from BOTH verdict paths.
 *
 * `reason` is what makes an `unknown` actionable: the word alone cannot distinguish an outcome that
 * has not arrived from a capture that could not be read, and only the first is worth asking about
 * again. `assert` records it, with a comment saying exactly that. `act_and_wait` — the commonest
 * path in the product — recorded the verdict and dropped the reason, so every fold over the journal
 * saw a verdict it could not attribute.
 *
 * Found by building the session gap summary: `undecidedBy` was empty for every unknown this tool
 * produced, and the act path's own comment about `kind` says "same field, same reason, on the
 * assert path", which was half true.
 *
 * Drives the REAL handler and reads what it hands `finishAction`, because the defect was entirely in
 * the object that crosses that boundary. A test over a hand-built journal action would have passed
 * throughout — which is how this survived.
 */
import { describe, expect, it } from 'vitest';
import {
  ReticleCommand,
  ReticleTool,
  SessionState,
  VerifiedReason,
  type CommandResult,
  type JournalVerdictEffect,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

/** A tab that dispatches the act and then answers every query with nothing, so the claim misses. */
function sessionRecordingItsJournal(): {
  deps: ToolDeps;
  recorded: () => JournalVerdictEffect | undefined;
} {
  let written: JournalVerdictEffect | undefined;
  const noEvents: ReticleEvent[] = [];
  const command = (name: string): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: ReticleCommand.MATCH === name ? { matched: false, count: 0, elements: [] } : {},
    } as CommandResult);
  const stub: Partial<Session> = {
    id: 'journal-demo',
    url: 'http://localhost:5173/app',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: (effect?: JournalVerdictEffect) => {
      written = effect;
    },
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
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
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return {
    recorded: () => written,
    deps: {
      sessions: sessions as SessionManager,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
      flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
      project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
        now: () => 0,
      }),
      annotations: new AnnotationStore(),
      fs: createNodeFileSystem(),
      reticleRoot: '/tmp/reticle-test/.reticle',
      now: () => 0,
    },
  };
}

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

describe('act_and_wait records WHY the verdict came out that way', () => {
  it('writes the deciding clause into the journal, not just the verdict', async () => {
    const { deps, recorded } = sessionRecordingItsJournal();
    await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'btn',
      action: 'click',
      timeout_ms: 0,
      until: { kind: 'element', query: { testid: 'never-appears' } },
    });
    const effect = recorded();
    expect(effect, 'nothing reached the journal at all').toBeDefined();
    expect(effect?.reason).toBe(VerifiedReason.ASSERTION_FAILED);
  });

  // The fields that were already carried, asserted beside the new one so a future edit that drops
  // one of them fails here rather than silently emptying a fold six modules away.
  it('still carries the claim, the kind and the pre-registration flag', async () => {
    const { deps, recorded } = sessionRecordingItsJournal();
    await tool(ReticleTool.ACT_AND_WAIT).handler(deps, {
      ref: 'btn',
      action: 'click',
      timeout_ms: 0,
      until: { kind: 'element', query: { testid: 'never-appears' } },
    });
    expect(recorded()).toMatchObject({ kind: 'element', declaredBeforeActing: true });
    expect(recorded()?.claim.length).toBeGreaterThan(0);
  });
});
