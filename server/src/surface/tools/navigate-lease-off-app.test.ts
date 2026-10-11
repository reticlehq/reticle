/**
 * From a persona drive: `reticle_navigate` to a URL with no Reticle SDK (a screenshot image) closed
 * the lease's session, and the next navigate answered "no connected session" — the agent had to
 * release the lease and sign in again. The page is still the lease's: navigating it goes through the
 * browser, and navigating back to the app reattaches.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';

describe('navigating a lease whose page has no Reticle SDK', () => {
  it('goes through the browser and reattaches when it is back on the app', async () => {
    const leaseUrl = 'http://localhost:4391/?__reticle_session=lease-1';
    const went: string[] = [];
    let attached = false;
    const session = { id: 'lease-1', url: leaseUrl };
    const deps = {
      now: () => 0,
      sessions: {
        resolve: (id?: string) => {
          if (!attached) throw new Error(`no connected session with id '${String(id)}'`);
          return session;
        },
        get: (id: string) => (attached && 'lease-1' === id ? session : undefined),
        all: () => (attached ? [session] : []),
      },
      pool: {
        leasedSessionIds: () => ['lease-1'],
        leaseUrl: () => leaseUrl,
        gotoLease: (_id: string, url: string) => {
          went.push(url);
          attached = url.startsWith('http://localhost:4391/');
          return Promise.resolve(true);
        },
        touch: () => undefined,
      },
    } as unknown as ToolDeps;
    const navigate = TOOLS.find((t) => ReticleTool.NAVIGATE === t.name);
    const back = (await navigate?.handler(deps, {
      sessionId: 'lease-1',
      url: 'http://localhost:4391/settings',
      timeout_ms: 50,
    })) as Record<string, unknown>;
    expect(went[0]).toContain('__reticle_session=lease-1');
    expect(back['ok']).toBe(true);
    expect(back['sessionId']).toBe('lease-1');
  });
});
