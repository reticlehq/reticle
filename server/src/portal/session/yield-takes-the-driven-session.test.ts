/**
 * An id-less yield with several projects connected releases the one tab this caller drove (#1258).
 *
 * Yield is non-destructive: it only hands the tab back to the human. It resolved its session like a
 * destructive action, so with two projects connected an id-less call got the "which session?"
 * refusal, and an agent that had just finished driving one tab had to look its id up to let go.
 */
import { describe, expect, it } from 'vitest';
import { PresenterTone, ReticleTool } from '@reticlehq/core';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';
import { LastAct } from './last-act.js';
import type { ToolDef } from '@/surface/tools/tools.js';

const toolNamed = (name: string): ToolDef => {
  const found = LIVE_CONTROL_TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
};

const AMBIGUOUS =
  '2 different projects are connected and nothing says which one this call is about';

interface FakeTab {
  id: string;
  lastAct: LastAct;
  ended: string[];
  autoEnd: (text: string) => void;
  markAgentActivity: () => void;
}

function tab(id: string, driven: boolean): FakeTab {
  const lastAct = new LastAct();
  if (driven) lastAct.markActed(7, 'click', 0);
  const ended: string[] = [];
  return {
    id,
    lastAct,
    ended,
    autoEnd: (text) => ended.push(text),
    markAgentActivity: () => undefined,
  };
}

/** A registry with two projects: an id-less resolve refuses, as the real one does. */
function deps(tabs: FakeTab[]): unknown {
  return {
    sessions: {
      count: () => tabs.length,
      get: (id: string) => tabs.find((t) => t.id === id),
      departed: () => undefined,
      all: () => tabs,
      resolve: (id?: string) => {
        if (id === undefined) throw new Error(AMBIGUOUS);
        const found = tabs.find((t) => t.id === id);
        if (found === undefined) throw new Error(`no such session '${id}'`);
        return found;
      },
    },
  };
}

/** The handler throws synchronously on a refusal, as it always has; awaited here either way. */
const yieldNow = async (d: unknown, args: Record<string, unknown> = {}) =>
  (await toolNamed(ReticleTool.YIELD).handler(d as never, {
    mode: PresenterTone.WAITING,
    ...args,
  })) as Record<string, unknown>;

describe('an id-less yield with several projects connected', () => {
  it('yields the one session this caller drove', async () => {
    const driven = tab('shop-1', true);
    const other = tab('admin-1', false);

    const result = await yieldNow(deps([other, driven]));

    expect(result['yielded']).toBe(true);
    expect(result['sessionId']).toBe('shop-1');
    expect(driven.ended).toHaveLength(1);
    expect(other.ended).toHaveLength(0);
  });

  it('still asks when no session was driven', async () => {
    await expect(yieldNow(deps([tab('shop-1', false), tab('admin-1', false)]))).rejects.toThrow(
      AMBIGUOUS,
    );
  });

  it('still asks when more than one session was driven', async () => {
    await expect(yieldNow(deps([tab('shop-1', true), tab('admin-1', true)]))).rejects.toThrow(
      AMBIGUOUS,
    );
  });

  it('never overrides a session the caller named', async () => {
    await expect(yieldNow(deps([tab('shop-1', true)]), { sessionId: 'gone' })).rejects.toThrow(
      "no such session 'gone'",
    );
  });
});
