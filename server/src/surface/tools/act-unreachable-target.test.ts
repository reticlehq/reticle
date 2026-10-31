/**
 * No "yes" on a target a person could not reach (matrix drive, bench-app).
 *
 * `nav-deployments-occluded`: the act result warned "a real user could not click it", and the
 * verdict said yes. `login-collapsed`: a 0×0 submit clicked by synthetic dispatch, and the sign-in
 * it caused verified yes. A consequence that held after a click no person could make proves nothing
 * about the app's users, so the verdict is unknown, naming the cause and the fix.
 */

import { describe, expect, it } from 'vitest';
import {
  ReticleCommand,
  ReticleTool,
  SessionState,
  Verified,
  VerifiedReason,
  type CommandResult,
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
const THANKS = 'Deployments';
const ROOT = '/tmp/reticle-test-reach/.reticle';

interface Paragraph {
  visible: boolean;
}

/**
 * A page whose MATCH answers with `before` until the action runs and with `after` once it has, and
 * whose window holds `events` only after the action.
 */
function page(before: Paragraph[], after: Paragraph[], effect: Record<string, unknown>): ToolDeps {
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
      result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1, ...effect } },
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
    queryEvents: () => Promise.resolve([]),
    eventsSince: () => [],
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

const SHOWN = { kind: 'element', query: { testid: 'deploy-table' }, state: 'visible' };
const appears = (): ToolDeps => page([], [{ visible: true }], {});
const appearsAfter = (effect: Record<string, unknown>): ToolDeps =>
  page([], [{ visible: true }], effect);

async function call(
  tool: string,
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const found = TOOLS.find((t) => t.name === tool);
  if (found === undefined) throw new Error(`${tool} is not on the surface`);
  return (await found.handler(deps, args)) as Record<string, unknown>;
}

const actAndWait = (deps: ToolDeps): Promise<Record<string, unknown>> =>
  call(ReticleTool.ACT_AND_WAIT, deps, { ref: 'e1', action: 'click', until: SHOWN });
const steps = (deps: ToolDeps): Promise<Record<string, unknown>> =>
  call(ReticleTool.ACT_SEQUENCE, deps, {
    steps: [{ ref: 'e1', action: 'click', expect: SHOWN }],
  });

describe('act_and_wait on a target a person could not reach', () => {
  it('is unknown when the target was covered, naming what covers it and the fix', async () => {
    const r = await actAndWait(
      appearsAfter({ occluded: true, occludedBy: 'e9', occluderName: '[data-testid="sheet"]' }),
    );
    expect(r['verified']).toBe(Verified.UNKNOWN);
    expect(r['verifiedReason']).toBe(VerifiedReason.INCONCLUSIVE);
    expect(String(r['because'])).toContain('covered by [data-testid="sheet"]');
  });

  it('is unknown when the target has no size, saying so', async () => {
    const r = await actAndWait(appearsAfter({ noSize: true, visible: false }));
    expect(r['verified']).toBe(Verified.UNKNOWN);
    expect(String(r['because'])).toContain('has no size');
    // noSize covers a box with EITHER side at zero (a 0×16 checkbox), so it must not claim 0×0.
    expect(String(r['because'])).not.toContain('0×0');
    expect(String(r['because'])).toContain('zero width or zero height');
  });

  it('is unknown when the target stayed off screen after scrolling', async () => {
    const r = await actAndWait(appearsAfter({ scrolledIntoView: true, offViewport: true }));
    expect(r['verified']).toBe(Verified.UNKNOWN);
    expect(String(r['because'])).toContain('outside the viewport');
  });

  it('is still yes on a target a person could click', async () => {
    const r = await actAndWait(appears());
    expect(r['verified']).toBe(Verified.YES);
  });
});

describe('act steps on a target a person could not reach', () => {
  it('is unknown, naming the cover, not yes', async () => {
    const r = await steps(
      appearsAfter({ occluded: true, occludedBy: 'e9', occluderName: '[data-testid="sheet"]' }),
    );
    expect(r['verified']).toBe(Verified.UNKNOWN);
    expect(String(r['because'])).toContain('covered by [data-testid="sheet"]');
  });

  it('is still yes on a target a person could click', async () => {
    const r = await steps(appears());
    expect(r['verified']).toBe(Verified.YES);
  });
});
