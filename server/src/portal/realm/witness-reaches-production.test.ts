import { describe, expect, it, afterEach } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { EventType, ReticleCommand, SessionState } from '@reticlehq/core';
import { RECONCILE_TOOLS } from '../../surface/tools/reconcile-tools.js';
import type { ToolDeps } from '../../surface/tools/tools.js';
import type { Session } from '../session/session.js';
import type { SessionManager } from '../session/session-manager.js';
import { witnessDisagreement } from '@reticlehq/engine/disagreement/witness-disagreement.js';

/**
 * The observer outside the app is reachable from a tool an agent can call — asserted by CALLING it.
 *
 * `Witness` shipped as a specification, a base class and a reference implementation, and for its
 * whole life nothing constructed one on any path a user could reach. Cross-realm disagreement — the
 * strongest finding this project can produce, and the only one that survives an app lying to itself
 * — had never fired once.
 *
 * The first version of this test read the handler's SOURCE and asserted it contained
 * `witnessDisagreement(`. That was a false green, proved by mutation: commenting the call out and
 * leaving the name in the comment kept it at 4 of 4. Writing a source string-match to catch a
 * built-and-unwired feature reproduces the very defect it was written against — this repository has
 * already recorded one guard that went green because a comment quoted the code it replaced.
 *
 * So the observer is stubbed and the assertion is that it was CONSULTED. Rename the helper, inline
 * it, move it — these hold. Stop consulting the observer and they go red.
 */
const reconcile = (): (typeof RECONCILE_TOOLS)[number] => {
  const tool = RECONCILE_TOOLS.find((t) => t.name === ReticleTool.RECONCILE);
  if (tool === undefined) throw new Error('reticle_reconcile is not on the surface');
  return tool;
};

/** A session that answers a snapshot and one API response — the same shape reconcile's own test uses. */
function reconcileDeps(pages: Record<string, unknown>): ToolDeps {
  const session = {
    id: 's1',
    queryEvents: () =>
      Promise.resolve([
        {
          type: EventType.NET_REQUEST,
          data: {
            url: '/api/settlements',
            responseBody: JSON.stringify([{ id: 'stl_1', status: 'on_hold' }]),
          },
        },
      ]),
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
  return {
    sessions: { resolve: () => session } as unknown as SessionManager,
  } as unknown as ToolDeps;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the witness is reachable from the surface', () => {
  it('reticle_reconcile accepts a witness and can report one', () => {
    expect(Object.keys(reconcile().inputSchema ?? {})).toContain('witness');
    expect(Object.keys(reconcile().outputSchema ?? {})).toContain('witness');
  });

  it('CONSULTS the url it was given — the whole point of an outside observer', async () => {
    const asked: string[] = [];
    globalThis.fetch = ((url: string) => {
      asked.push(String(url));
      return Promise.resolve({ ok: true, text: () => Promise.resolve('stl_1') } as Response);
    }) as typeof fetch;
    await reconcile().handler(reconcileDeps({ '': { tree: '- text "on_hold"' } }), {
      sessionId: 's1',
      witness: { url: 'http://localhost:9/rows' },
    });
    expect(
      asked.some((u) => u.includes('localhost:9/rows')),
      'the outside observer was never contacted, so no disagreement could ever be found',
    ).toBe(true);
  });

  it('is NOT consulted when no witness was named — nobody pays for a request they did not ask for', async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response);
    };
    await reconcile().handler(reconcileDeps({ '': { tree: '- text "on_hold"' } }), {
      sessionId: 's1',
    });
    expect(calls).toBe(0);
  });

  it('an unreachable observer is INCONCLUSIVE, never agreement', () => {
    // The one safety property that must survive every future edit: "I could not check" and "I
    // checked and it was fine" are opposite answers.
    const f = witnessDisagreement({
      appClaims: true,
      witnessSaw: undefined,
      unreachable: 'refused',
    });
    expect(f?.inconclusive).toBe(true);
    expect(f?.kind).toBe('witness-unreachable');
  });

  it('disagreement is reported when the app claims what the observer did not see', () => {
    expect(witnessDisagreement({ appClaims: true, witnessSaw: false })?.kind).toBe(
      'witness-disagrees',
    );
    expect(witnessDisagreement({ appClaims: true, witnessSaw: true })).toBeUndefined();
  });
});
