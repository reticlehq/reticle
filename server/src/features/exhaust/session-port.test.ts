import { describe, expect, it } from 'vitest';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { sessionReplacedReason } from '@/portal/session/facts/session-replaced.js';
import { sessionPort, type PortSession } from './session-port.js';

/*
 * A full page load replaces the session object under the same id. Every call has to follow it, or
 * the second step of any journey on a server-rendered app runs against a dead document.
 */
function world() {
  let generation = 0;
  const log: string[] = [];
  const make = (): PortSession => {
    const mine = generation;
    return {
      id: 's1',
      url: 'http://h/start',
      elapsed: () => 0,
      eventsSince: (): ReticleEvent[] => [],
      command: (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        if (mine !== generation) return Promise.reject(new Error(sessionReplacedReason('s1', 'x')));
        log.push(`${String(mine)}:${name}`);
        if ('navigate' === name || ('act' === name && 'link' === args?.['ref'])) {
          generation += 1;
          current = make();
          if ('act' === name) return Promise.reject(new Error(sessionReplacedReason('s1', 'x')));
        }
        return Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { dispatched: true, tree: '' },
        });
      },
    };
  };
  let current = make();
  const port = sessionPort({
    sessions: { get: () => current },
    start: current,
    startUrl: 'http://h/start',
    settleMs: 0,
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
  });
  return { port, log };
}

describe('sessionPort follows the document across full loads', () => {
  it('resets onto the new session, and the next read goes to it', async () => {
    const { port, log } = world();
    expect(await port.reset()).toBe(true);
    await port.look();
    expect(log.at(-1)).toMatch(/^1:/);
  });

  it('treats a click that followed a real link as a click that worked', async () => {
    const { port, log } = world();
    expect((await port.act('link', 'click')).ok).toBe(true);
    await port.look();
    expect(log.at(-1)).toMatch(/^1:/);
  });
});
