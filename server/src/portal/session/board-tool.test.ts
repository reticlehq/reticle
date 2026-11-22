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
