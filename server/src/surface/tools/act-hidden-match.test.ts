/**
 * A `text` check that matched only a hidden node is not a clean `yes` (#1408).
 *
 * The page had `<p hidden>Thank you</p>` and a submit whose POST returned 200 without ever showing
 * it. `act_and_wait` with `allOf [net POST /submit 200, text "Thank you"]` came back `verified: yes`.
 * The hidden-match caveat existed, but only for a consequence that was already true, and a `net`
 * clause never is.
 */

import { describe, expect, it } from 'vitest';
import {
  EventType,
  ReticleCommand,
  ReticleTool,
  SessionState,
  Verified,
  VerifiedReason,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { TOOLS, type ToolDeps } from './tools.js';

const NOW = 1000;
const THANKS = 'Thank you';
const ROOT = '/tmp/reticle-test/.reticle';

interface Paragraph {
  visible: boolean;
}

/**
 * A page whose MATCH answers with `before` until the action runs and with `after` once it has, and
 * whose window holds `events` only after the action.
 */
function page(before: Paragraph[], after: Paragraph[], events: ReticleEvent[] = []): ToolDeps {
  let acted = false;
  const described = (ps: Paragraph[]): unknown[] =>
    ps.map((p, i) => ({
      ref: `p${String(i)}`,
      role: 'paragraph',
      name: THANKS,
      states: [],
      visible: p.visible,
    }));
  const command = (name: string): Promise<CommandResult> => {
    if (ReticleCommand.MATCH === name) {
      const ps = acted ? after : before;
      return Promise.resolve({
        kind: 'command_result',
        id: 'm',
        ok: true,
        result: { matched: ps.length > 0, count: ps.length, elements: described(ps) },
      });
    }
    if (ReticleCommand.ACT === name) acted = true;
    return Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1 } },
    });
  };
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/form',
    elapsed: () => NOW,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    recordAction: () => 'a1',
    command,
    queryEvents: () => Promise.resolve(acted ? events : []),
    eventsSince: () => (acted ? events : []),
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
  const sessions: Partial<SessionManager> = { resolve: () => stub as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: ROOT,
    now: () => 0,
  };
}

const posted: ReticleEvent = {
  type: EventType.NET_REQUEST,
  t: NOW,
  data: { id: 'r1', method: 'POST', url: 'http://localhost:5173/submit', status: 200 },
} as unknown as ReticleEvent;

/** The submit button re-enabling once the POST answers: the page did react, just not visibly. */
const reenabled: ReticleEvent = {
  type: EventType.DOM_ATTR,
  t: NOW,
  data: { ref: 'e1', attr: 'disabled' },
} as unknown as ReticleEvent;

const TEXT = { kind: 'text', contains: THANKS };
const SUBMITTED = {
  kind: 'allOf',
  predicates: [{ kind: 'net', method: 'POST', urlContains: '/submit', status: 200 }, TEXT],
};

async function actAndWait(deps: ToolDeps, until: unknown): Promise<Record<string, unknown>> {
  const found = TOOLS.find((t) => t.name === ReticleTool.ACT_AND_WAIT);
  if (found === undefined) throw new Error('act_and_wait is not on the surface');
  return (await found.handler(deps, { ref: 'e1', action: 'click', until })) as Record<
    string,
    unknown
  >;
}

describe('a text check that matched only hidden nodes is not a clean yes', () => {
  it('the request succeeded and the thank-you is still hidden: unknown, naming visible: true', async () => {
    const hidden = [{ visible: false }];
    const r = await actAndWait(page(hidden, hidden, [posted, reenabled]), SUBMITTED);
    expect(r['verified']).toBe(Verified.UNKNOWN);
    expect(r['verifiedReason']).toBe(VerifiedReason.HIDDEN_MATCH);
    expect(String(r['because'])).toContain('visible: true');
  });

  it('a hidden node mounted during the action, with a bare text until: unknown too', async () => {
    const r = await actAndWait(page([], [{ visible: false }]), TEXT);
    expect(r['verified']).toBe(Verified.UNKNOWN);
    expect(String(r['because'])).toContain('visible: true');
  });

  it('a visible match is unaffected', async () => {
    const r = await actAndWait(
      page([{ visible: false }], [{ visible: true }], [posted, reenabled]),
      SUBMITTED,
    );
    expect(r['verifiedReason']).not.toBe(VerifiedReason.HIDDEN_MATCH);
  });

  it('one visible match among several hidden is unaffected', async () => {
    const some = [{ visible: false }, { visible: true }, { visible: false }];
    const r = await actAndWait(page([], some), TEXT);
    expect(r['verifiedReason']).not.toBe(VerifiedReason.HIDDEN_MATCH);
  });
});
