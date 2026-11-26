import { describe, expect, it } from 'vitest';

import type { ToolDeps } from '@/surface/tools/tool-kit.js';

import { BOARD_MAX_VALUE, BOARD_TOOL } from './live-control-tools.js';

const depsWith = (sessions: object, at = 1): ToolDeps =>
  ({ sessions, now: () => at }) as unknown as ToolDeps;

// A desktop session and a browser session, or two agents, had no way to pass a value to each
// other through the bridge: each one saw only its own session.
describe('the board of the bridge', () => {
  it('keeps a value one session writes for every other to read', async () => {
    const bridge = {};
    await BOARD_TOOL.handler(depsWith(bridge, 5), {
      key: 'total',
      value: '69,104',
      sessionId: 'cu-calc',
    });
    expect(await BOARD_TOOL.handler(depsWith(bridge), { key: 'total' })).toEqual({
      ok: true,
      entries: [{ key: 'total', value: '69,104', from: 'cu-calc', at: 5 }],
    });
    expect(await BOARD_TOOL.handler(depsWith(bridge), {})).toMatchObject({
      entries: [{ key: 'total' }],
    });
  });

  it('is one board for each bridge', async () => {
    await BOARD_TOOL.handler(depsWith({}), { key: 'k', value: 'v' });
    expect(await BOARD_TOOL.handler(depsWith({}), {})).toEqual({ ok: true, entries: [] });
  });

  it('refuses a value too long to keep, and says what to do, never cutting it', async () => {
    const bridge = {};
    const answer = await BOARD_TOOL.handler(depsWith(bridge), {
      key: 'big',
      value: 'x'.repeat(BOARD_MAX_VALUE + 1),
    });
    expect(answer).toMatchObject({ ok: false });
    expect(await BOARD_TOOL.handler(depsWith(bridge), { key: 'big' })).toMatchObject({ ok: false });
  });

  it('says which keys there are when a key is not there', async () => {
    const bridge = {};
    await BOARD_TOOL.handler(depsWith(bridge), { key: 'a', value: '1' });
    expect(await BOARD_TOOL.handler(depsWith(bridge), { key: 'b' })).toEqual({
      ok: false,
      error: 'no value has the key "b" yet. Keys on the board: a.',
    });
  });
});

// The board carried only what an agent typed into it: a value read in one session reached another
// only if the agent copied it right, and nothing said whether it arrived. A carry reads the value
// from the element itself, writes it into the element of the other session, and reads it back.
describe('a carry from one session to another', () => {
  /** A session whose tree is lines, and whose fill sets the value of a ref (unless it is deaf). */
  const fakeSession = (lines: Record<string, string>, deaf = false) => {
    const values: Record<string, string> = {};
    return {
      beginAction: () => 'a1',
      finishAction: () => undefined,
      command: (name: string, args: Record<string, unknown>) => {
        if ('snapshot' === name) {
          const tree = Object.entries(lines)
            .map(([ref, line]) =>
              values[ref] === undefined ? line : `${line} [value="${values[ref] ?? ''}"]`,
            )
            .join('\n');
          return Promise.resolve({ ok: true, result: { tree } });
        }
        if ('act' === name && !deaf) {
          const value = (args['args'] as { value?: string } | undefined)?.value ?? '';
          values[String(args['ref'])] = value;
        }
        return Promise.resolve({ ok: true, result: { ok: true } });
      },
    };
  };
  const bridgeOf = (sessions: Record<string, object>) => ({
    resolve: (id: string) => {
      const found = sessions[id];
      if (found === undefined) {
        throw new Error(`no session ${id}`);
      }
      return found;
    },
  });
  const calculator = fakeSession({ e5: '- text "69,104" (ref=e5)' });

  it('reads the value from the element, writes it in the other session, and proves it arrived', async () => {
    const bridge = bridgeOf({
      calc: calculator,
      page: fakeSession({ e3: '- textbox "Total" (ref=e3)' }),
    });
    const carried = await BOARD_TOOL.handler(depsWith(bridge, 7), {
      key: 'total',
      carry: { from: { sessionId: 'calc', ref: 'e5' }, to: { sessionId: 'page', ref: 'e3' } },
    });
    expect(carried).toMatchObject({ ok: true, carried: '69,104', arrived: true });
    expect(await BOARD_TOOL.handler(depsWith(bridge), { key: 'total' })).toMatchObject({
      entries: [{ key: 'total', value: '69,104', from: 'calc' }],
    });
  });

  it('says it did not arrive, and what the target shows, when the target did not take it', async () => {
    const bridge = bridgeOf({
      calc: calculator,
      page: fakeSession({ e3: '- textbox "Total" (ref=e3)' }, true),
    });
    expect(
      await BOARD_TOOL.handler(depsWith(bridge), {
        key: 'total',
        carry: { from: { sessionId: 'calc', ref: 'e5' }, to: { sessionId: 'page', ref: 'e3' } },
      }),
    ).toMatchObject({ ok: true, carried: '69,104', arrived: false, shows: '' });
  });

  it('refuses a source ref that is not in its session', async () => {
    const bridge = bridgeOf({ calc: calculator, page: fakeSession({}) });
    expect(
      await BOARD_TOOL.handler(depsWith(bridge), {
        key: 'total',
        carry: { from: { sessionId: 'calc', ref: 'e9' }, to: { sessionId: 'page', ref: 'e3' } },
      }),
    ).toMatchObject({ ok: false });
    const refused = (await BOARD_TOOL.handler(depsWith(bridge), {
      key: 'total',
      carry: { from: { sessionId: 'calc', ref: 'e9' }, to: { sessionId: 'page', ref: 'e3' } },
    })) as { error?: string };
    expect(refused.error).toContain('e9');
  });
});
