import { describe, expect, it } from 'vitest';
import {
  HelloScope,
  LOOPBACK_HOST,
  PRODUCTION_ACTIVATE_PARAM,
  PRODUCTION_REFUSAL_PREFIX,
  PRODUCTION_TICKET_PATH,
  ProductionRule,
  RETICLE_WS_PATH,
} from '@reticlehq/core';
import { SessionNonces } from '@/portal/bridge/session-nonces.js';
import {
  activateProduction,
  leaseWithoutInjection,
  notActivatedHint,
  PRODUCTION_MODE_NOT_LINKED,
  PRODUCTION_MODE_NOT_OFFERED,
  type TicketFetch,
} from './production-activation.js';

const CLOUD = { url: 'https://cloud.example.com/', apiKey: 'rk_live_test' };
const SITE = 'https://app.example.com/overview';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake ticket server: records each call and answers with `status` and `body`. */
function server(status: number, body: unknown): { fetch: TicketFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as unknown });
      return Promise.resolve({
        ok: 200 <= status && status < 300,
        status,
        json: () => Promise.resolve(body),
      });
    },
  };
}

function nonces(): SessionNonces {
  let n = 0;
  return new SessionNonces({ clock: () => 1_000, random: () => `nonce-${String((n += 1))}` });
}

const ask = { workspaceId: 'ws_staff', scope: HelloScope.ACT, intent: 'invite a teammate' };

describe('activating a production drive', () => {
  it('mints a nonce, asks the service for a ticket, and opens the site carrying it', async () => {
    const fake = server(200, { ticket: 'signed-ticket' });
    const registry = nonces();
    const activated = await activateProduction({
      production: ask,
      url: SITE,
      nonces: registry,
      bridgePort: 4400,
      cloud: () => Promise.resolve(CLOUD),
      fetch: fake.fetch,
    });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe(`https://cloud.example.com${PRODUCTION_TICKET_PATH}`);
    expect(call?.headers['authorization']).toBe('Bearer rk_live_test');
    expect(call?.body).toEqual({
      workspaceId: 'ws_staff',
      nonce: 'nonce-1',
      bridgePort: 4400,
      scope: 'act',
      // The service binds the ticket to the origin it is told and the bridge it is told; it never
      // guesses either from the port (a hosted verifier runs a bridge per site).
      origin: 'https://app.example.com',
      bridge: `ws://${LOOPBACK_HOST}:4400${RETICLE_WS_PATH}`,
    });
    expect(new URL(activated.url).searchParams.get(PRODUCTION_ACTIVATE_PARAM)).toBe(
      'signed-ticket',
    );
    // The nonce the service was given is the one the page will present, and it opens production.
    expect(registry.redeem('nonce-1', 'tab-1')?.production?.scope).toBe(HelloScope.ACT);
    expect(registry.admitsOrigin('https://app.example.com')).toBe(true);
  });

  it('applies the policy list the service sent with the ticket', async () => {
    const policy = [{ rule: ProductionRule.SEND_INVITE, methods: ['POST'], path: '/team/add$' }];
    const fake = server(200, { ticket: 't', policy });
    const activated = await activateProduction({
      production: { workspaceId: 'ws_staff', scope: HelloScope.ACT },
      url: SITE,
      nonces: nonces(),
      bridgePort: 4400,
      cloud: () => Promise.resolve(CLOUD),
      fetch: fake.fetch,
    });
    expect(activated.drive.refuseRequest('POST', '/team/add')).toContain(
      `${PRODUCTION_REFUSAL_PREFIX}${ProductionRule.SEND_INVITE}`,
    );
    expect(activated.drive.refuseRequest('POST', '/v1/invites')).toBeUndefined();
  });

  it('says the server does not offer production mode when the route is missing', async () => {
    await expect(
      activateProduction({
        production: ask,
        url: SITE,
        nonces: nonces(),
        bridgePort: 4400,
        cloud: () => Promise.resolve(CLOUD),
        fetch: server(404, { error: 'not found' }).fetch,
      }),
    ).rejects.toThrow(PRODUCTION_MODE_NOT_OFFERED);
  });

  it('passes on the reason when the service refuses the ticket', async () => {
    await expect(
      activateProduction({
        production: ask,
        url: SITE,
        nonces: nonces(),
        bridgePort: 4400,
        cloud: () => Promise.resolve(CLOUD),
        fetch: server(403, { error: 'workspace is not a staff workspace' }).fetch,
      }),
    ).rejects.toThrow(/HTTP 403.*not a staff workspace/);
  });

  it('refuses without linked cloud credentials, and never calls out', async () => {
    const fake = server(200, { ticket: 't' });
    await expect(
      activateProduction({
        production: ask,
        url: SITE,
        nonces: nonces(),
        bridgePort: 4400,
        cloud: () => Promise.resolve(null),
        fetch: fake.fetch,
      }),
    ).rejects.toThrow(PRODUCTION_MODE_NOT_LINKED);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a production argument without a workspace or a scope', async () => {
    await expect(
      activateProduction({
        production: { workspaceId: 'ws_staff' },
        url: SITE,
        nonces: nonces(),
        bridgePort: 4400,
        cloud: () => Promise.resolve(CLOUD),
        fetch: server(200, { ticket: 't' }).fetch,
      }),
    ).rejects.toThrow(/production/);
  });

  it('refuses a ticket whose policy is unbounded or not a pattern, and opens nothing', async () => {
    const entry = { rule: ProductionRule.SEND_INVITE, methods: ['POST'], path: '/invites' };
    for (const policy of [Array.from({ length: 65 }, () => entry), [{ ...entry, path: '(' }]]) {
      await expect(
        activateProduction({
          production: ask,
          url: SITE,
          nonces: nonces(),
          bridgePort: 4400,
          cloud: () => Promise.resolve(CLOUD),
          fetch: server(200, { ticket: 't', policy }).fetch,
        }),
      ).rejects.toThrow(/not a ticket/);
    }
  });
});

describe('a production lease', () => {
  it('never injects an SDK: the site loads its own behind the ticket, or not at all', () => {
    const isLoading = (): Promise<boolean> => Promise.resolve(false);
    const lease = { injectReader: () => Promise.resolve(true), isLoading };
    const without = leaseWithoutInjection(lease);
    expect(without).not.toHaveProperty('injectReader');
    expect(without.isLoading).toBe(isLoading);
  });

  // A fresh leased browser is signed out, so the service refused the ticket and the page never
  // connected. The hint blamed the page's CSP and said to allow the bridge for development only.
  it('names the signed-out browser when an activated page never connects, never the CSP', () => {
    const hint = notActivatedHint(SITE);
    expect(hint).toMatch(/signed in/);
    expect(hint).toMatch(/seedStorage/);
    expect(hint).not.toMatch(/Content-Security-Policy|connect-src/);
  });
});
