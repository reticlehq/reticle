/**
 * `reticle verify` replays every flow in ONE driven page. A flow that signs out (an auto-saved
 * "log out" fragment) left every flow after it signed out, so a suite of correct journeys graded
 * `unknown` or `no` on a working app. Each flow must start from the state the run started with.
 */
import { describe, expect, it, vi } from 'vitest';
import { ReplayStatus } from '@reticlehq/core';
import { createRunnerPort } from '@/judgement/runs/runner-port.js';
import { replayAndLearn } from '@/language/flows/flow-learning.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

vi.mock('@/language/flows/flow-learning.js', () => ({
  replayAndLearn: vi.fn((_deps: unknown, args: { flowName: string }) =>
    Promise.resolve({ name: args.flowName, status: ReplayStatus.OK, steps: [] }),
  ),
}));

const PAGE = 'http://localhost:3000/';

function depsWith(applyOk: boolean) {
  const calls: string[] = [];
  const realInput = {
    isAvailableFor: () => Promise.resolve(true),
    storageState: () => {
      calls.push('capture');
      return Promise.resolve({ cookies: [{ name: 'token' }] });
    },
    applyStorageState: (_url: string, state: unknown) => {
      calls.push(`apply:${JSON.stringify(state)}`);
      return Promise.resolve(applyOk);
    },
  };
  const deps = { realInput, sessions: { resolve: () => ({ url: PAGE }) } } as unknown as ToolDeps;
  vi.mocked(replayAndLearn).mockImplementation((_d, args) => {
    calls.push(`replay:${String(args['flowName'])}`);
    return Promise.resolve({ name: String(args['flowName']), status: ReplayStatus.OK, steps: [] });
  });
  return { deps, calls };
}

describe('each flow of a verify run starts from the state the run started with', () => {
  it('captures before the first flow and restores before each later one', async () => {
    const { deps, calls } = depsWith(true);
    const port = createRunnerPort(deps);
    await port.replayFlow('a');
    await port.replayFlow('b');
    await port.replayFlow('c');
    const state = JSON.stringify({ cookies: [{ name: 'token' }] });
    expect(calls).toEqual([
      'capture',
      'replay:a',
      `apply:${state}`,
      'replay:b',
      `apply:${state}`,
      'replay:c',
    ]);
  });

  it('reports a flow it could not put back in the start state as not proved, and does not run it', async () => {
    const { deps, calls } = depsWith(false);
    const port = createRunnerPort(deps);
    await port.replayFlow('a');
    const second = await port.replayFlow('b');
    expect(second.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(second.unverifiable?.reason).toContain('start');
    expect(calls).not.toContain('replay:b');
  });

  it('replays as before when nothing can capture state', async () => {
    const calls: string[] = [];
    vi.mocked(replayAndLearn).mockImplementation((_d, args) => {
      calls.push(`replay:${String(args['flowName'])}`);
      return Promise.resolve({
        name: String(args['flowName']),
        status: ReplayStatus.OK,
        steps: [],
      });
    });
    const port = createRunnerPort({
      sessions: { resolve: () => ({ url: PAGE }) },
    } as unknown as ToolDeps);
    await port.replayFlow('a');
    await port.replayFlow('b');
    expect(calls).toEqual(['replay:a', 'replay:b']);
  });
});

describe('a flow that moved the page to another address', () => {
  it('still gets the start state back: the page is the same driven page', async () => {
    // Seen in use: after a flow that signed out and reloaded, the session's recorded address
    // no longer equalled the page's, the address check refused, and every later flow read
    // "could not put the page back" on a working app.
    const { deps, calls } = depsWith(true);
    let looks = 0;
    (
      deps as unknown as { realInput: { isAvailableFor: () => Promise<boolean> } }
    ).realInput.isAvailableFor = () => Promise.resolve(0 === looks++);
    const port = createRunnerPort(deps);
    await port.replayFlow('a');
    const second = await port.replayFlow('b');
    expect(second.status).toBe(ReplayStatus.OK);
    expect(calls).toContain('replay:b');
  });
});

describe('a flow that opened another tab', () => {
  it('has the tab closed before the next flow, so one page stays connected', async () => {
    // Seen in use: a recorded flow signed out by opening "Log out" in a new tab. The tab
    // stayed, its session stayed connected, and every later flow stopped at "multiple sessions
    // connected". Starting where the run started means the same tabs too.
    const { deps, calls } = depsWith(true);
    (
      deps as unknown as { realInput: { closeOtherPages: () => Promise<number> } }
    ).realInput.closeOtherPages = () => {
      calls.push('close-other-pages');
      return Promise.resolve(1);
    };
    const port = createRunnerPort(deps);
    await port.replayFlow('a');
    await port.replayFlow('b');
    const state = JSON.stringify({ cookies: [{ name: 'token' }] });
    expect(calls).toEqual([
      'capture',
      'replay:a',
      'close-other-pages',
      `apply:${state}`,
      'replay:b',
    ]);
  });
});
