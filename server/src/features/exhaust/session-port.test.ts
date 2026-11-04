import { describe, expect, it } from 'vitest';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { sessionReplacedReason } from '@/portal/session/facts/session-replaced.js';
import { PENDING_WAIT_MS, sessionPort, type PortSession } from './session-port.js';

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
        if (mine !== generation) {
          return Promise.reject(new Error(sessionReplacedReason('s1', 'x')));
        }
        log.push(`${String(mine)}:${name}`);
        if ('navigate' === name || ('act' === name && 'link' === args?.['ref'])) {
          generation += 1;
          current = make();
          if ('act' === name) {
            return Promise.reject(new Error(sessionReplacedReason('s1', 'x')));
          }
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

/*
 * The edge-case drive needs three things a plain explore never asked for: two clicks back to back,
 * a reload and a back, and the attributes that say what a field takes.
 */
function recorder(result: Record<string, unknown> = { dispatched: true }) {
  const sent: { name: string; args: Record<string, unknown> | undefined }[] = [];
  let sleeps = 0;
  let current: PortSession;
  const make = (url: string): PortSession => ({
    id: 's1',
    url,
    elapsed: () => 0,
    eventsSince: (): ReticleEvent[] => [],
    command: (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
      sent.push({ name, args });
      if ('navigate' === name || 'refresh' === name) {
        current = make('navigate' === name ? String(args?.['url']) : url);
      }
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
  });
  current = make('http://h/form');
  const port = sessionPort({
    sessions: { get: () => current },
    start: current,
    startUrl: 'http://h/start',
    settleMs: 5,
    now: () => Date.now(),
    sleep: () => {
      sleeps += 1;
      return Promise.resolve();
    },
  });
  return { port, sent, sleeps: () => sleeps };
}

describe('sessionPort drives edge cases', () => {
  it('does not wait after an action asked not to settle', async () => {
    const { port, sleeps } = recorder();
    await port.act('e1', 'click', undefined, { settle: false });
    expect(sleeps()).toBe(0);
    await port.act('e1', 'click');
    expect(sleeps()).toBe(1);
  });

  it('gives the source the page reported for the element', async () => {
    const { port } = recorder({ dispatched: true, source: { file: 'src/Form.tsx', line: 7 } });
    expect((await port.act('e1', 'click')).source).toEqual({ file: 'src/Form.tsx', line: 7 });
  });

  it('reloads with a refresh, and goes back to the URL before the last action', async () => {
    const { port, sent } = recorder();
    expect(await port.back?.()).toBe(false);
    expect(await port.reload?.()).toBe(true);
    expect(sent.at(-1)?.name).toBe('refresh');
    await port.act('e1', 'click');
    expect(await port.back?.()).toBe(true);
    expect(sent.at(-1)).toEqual({ name: 'navigate', args: { url: 'http://h/form' } });
  });

  it('reads a field attributes with one query by role and name', async () => {
    const { port, sent } = recorder({ elements: [{ attrs: { maxlength: '10', required: '' } }] });
    expect(await port.fieldAttrs?.('textbox "Title"')).toEqual({ maxlength: '10', required: '' });
    expect(sent.at(-1)?.name).toBe('query');
    expect(sent.at(-1)?.args).toMatchObject({ role: 'textbox', name: 'Title' });
    expect(sent.at(-1)?.args?.['attrs']).toContain('maxlength');
  });

  it('reads the whole page for a full look', async () => {
    const { port, sent } = recorder({ tree: '- heading "Saved"' });
    expect((await port.lookFull?.())?.tree).toBe('- heading "Saved"');
    expect(sent.at(-1)?.args).toEqual({ mode: 'full' });
  });
});

/*
 * bench-app's Generate answers after six seconds. The press settled after 300 ms, its write had not
 * answered, and the explorer never saw the write, its 500 or its second copy. A press now waits for
 * the requests it started, up to a bound.
 */
describe('sessionPort waits for the requests a press started', () => {
  function slowWrite(answersAfterSleeps: number) {
    let clock = 0;
    let sleeps = 0;
    const pending = {
      type: 'net.pending',
      t: 1,
      data: { id: 'r1', method: 'POST', url: '/api/g' },
    };
    const done = {
      type: 'net.request',
      t: 2,
      data: { id: 'r1', method: 'POST', url: '/api/g', status: 500 },
    };
    const session: PortSession = {
      id: 's1',
      url: 'http://h/',
      elapsed: () => 0,
      eventsSince: () =>
        (sleeps > answersAfterSleeps ? [pending, done] : [pending]) as unknown as ReticleEvent[],
      command: () =>
        Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { dispatched: true },
        }),
    };
    const port = sessionPort({
      sessions: { get: () => session },
      start: session,
      startUrl: 'http://h/',
      settleMs: 300,
      now: () => clock,
      sleep: (ms) => {
        sleeps += 1;
        clock += ms;
        return Promise.resolve();
      },
    });
    return { port, clock: () => clock };
  }

  it('returns the answer of a write that came back after the settle', async () => {
    const { port } = slowWrite(5);
    const { events } = await port.act('e1', 'click');
    expect(events.map((e) => e.type)).toEqual(['net.pending', 'net.request']);
  });

  it('stops waiting at its bound for a write that never answers', async () => {
    const { port, clock } = slowWrite(Number.POSITIVE_INFINITY);
    const { events } = await port.act('e1', 'click');
    expect(events.map((e) => e.type)).toEqual(['net.pending']);
    expect(clock()).toBeLessThanOrEqual(PENDING_WAIT_MS + 300);
  });
});
