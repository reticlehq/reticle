import { describe, expect, it } from 'vitest';
import { EventType, ReticleCommand, SessionState } from '@reticlehq/core';
import { RECONCILE_TOOLS } from './reconcile-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tools.js';
import type { Session, SessionManager } from '../session/session.js';

const RESPONSE = {
  type: EventType.NET_REQUEST,
  data: {
    url: '/api/settlements',
    responseBody: JSON.stringify([
      { id: 'stl_1', status: 'on_hold' },
      { id: 'stl_2', status: 'paid' },
    ]),
  },
};

/** A session whose snapshot answers per scope, so a cut page can be scripted branch by branch. */
function reconcileDeps(pages: Record<string, unknown>): ToolDeps {
  const session = {
    id: 's1',
    queryEvents: () => Promise.resolve([RESPONSE]),
    command: (name: string, args: Record<string, unknown>) =>
      Promise.resolve({
        kind: 'command_result',
        id: 'x',
        ok: true,
        result:
          name === ReticleCommand.SNAPSHOT
            ? (pages['string' === typeof args['scope'] ? args['scope'] : ''] ?? { tree: '' })
            : {},
      }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  } as unknown as Session;
  const sessions = { resolve: () => session } as unknown as SessionManager;
  return { sessions } as unknown as ToolDeps;
}

function reconcileTool() {
  const t = RECONCILE_TOOLS.find((x) => x.name === ReticleTool.RECONCILE);
  if (t === undefined) throw new Error('no reticle_reconcile tool');
  return t;
}

/**
 * "Nothing on screen contradicts them" is a NEGATIVE conclusion, and it used to be drawn over a
 * snapshot that may have stopped at its node cap. The row that disagreed could simply have been past
 * the cut, and nothing in the answer said so.
 */
describe('reconcile refuses to call a page clean it could not read', () => {
  it('reports a clean comparison over a page that was read whole', async () => {
    const r = (await reconcileTool().handler(
      reconcileDeps({ '': { tree: '- text "on hold"\n- text "paid"', truncated: false } }),
      {},
    )) as { mismatches: unknown[]; note?: string };
    expect(r.mismatches).toEqual([]);
    expect(r.note).toContain('nothing on screen contradicts');
  });

  it('finishes a cut page by re-reading its branches, then reports on the whole tree', async () => {
    const r = (await reconcileTool().handler(
      reconcileDeps({
        // Cut BEFORE the row that agrees: read alone, this prefix reports a mismatch that is not real.
        '': { tree: '- text "paid"', truncated: true, unread: ['e2'] },
        e2: { tree: '- text "on hold"', truncated: false },
      }),
      {},
    )) as { mismatches: unknown[]; note?: string };
    expect(r.mismatches).toEqual([]);
    expect(r.note).toContain('nothing on screen contradicts');
  });

  it('throws rather than returning an empty comparison over a page it could not finish', async () => {
    await expect(
      reconcileTool().handler(
        reconcileDeps({
          '': {
            tree: '- text "irrelevant"',
            truncated: true,
            unread: ['e2'],
            unreadOverflow: true,
          },
        }),
        {},
      ),
    ).rejects.toThrow(/could not be read/i);
  });

  it('still reports a mismatch it FOUND in a page it could not finish', async () => {
    const r = (await reconcileTool().handler(
      reconcileDeps({
        '': {
          tree: '- text "paid"',
          truncated: true,
          unread: ['e2'],
          unreadOverflow: true,
        },
      }),
      {},
    )) as { mismatches: unknown[] };
    expect(r.mismatches.length).toBeGreaterThan(0);
  });
});
