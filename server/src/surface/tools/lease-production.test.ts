/**
 * `reticle_lease { action: "acquire", url, production: { workspaceId, scope } }`: one step from a
 * URL to an activated production drive. The nonce is minted, the service is asked for a ticket, and
 * the site opens carrying it, and the page's requests are guarded by the production policy before
 * they leave the browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HelloScope,
  LOOPBACK_HOST,
  PRODUCTION_ACTIVATE_PARAM,
  PRODUCTION_REFUSAL_PREFIX,
  PRODUCTION_TICKET_PATH,
  RETICLE_WS_PATH,
  ReticleTool,
} from '@reticlehq/core';
import { LEASE_TOOLS } from './lease-tools.js';
import type { ToolDeps } from './tool-kit.js';
import type { BrowserPool, Lease } from '@/portal/pool/browser-pool.js';
import { SessionNonces } from '@/portal/bridge/session-nonces.js';
import { PRODUCTION_MODE_NOT_OFFERED } from '@/portal/production/production-activation.js';

const SITE = 'https://app.example.com/overview';

function acquire(deps: ToolDeps, args: Record<string, unknown>): Promise<unknown> {
  const def = LEASE_TOOLS.find((t) => t.name === ReticleTool.LEASE_ACQUIRE);
  if (def === undefined) throw new Error('no acquire tool');
  return def.handler(deps, args);
}

interface Recorded {
  pool: BrowserPool;
  acquired: string[];
  permissions: (readonly string[] | undefined)[];
  guard: ((method: string, url: string) => string | undefined) | undefined;
}

function fakePool(): Recorded {
  const recorded: Recorded = {
    pool: undefined as unknown as BrowserPool,
    acquired: [],
    permissions: [],
    guard: undefined,
  };
  recorded.pool = {
    acquire(
      url: string,
      o: { sessionId?: string; permissions?: readonly string[] } = {},
    ): Promise<Lease> {
      recorded.acquired.push(url);
      recorded.permissions.push(o.permissions);
      return Promise.resolve({
        sessionId: o.sessionId ?? 'gen',
        url,
        release: () => Promise.resolve(),
      });
    },
    release: () => Promise.resolve(),
    activeCount: () => 1,
    queuedCount: () => 0,
    leaseTtlMs: () => 300_000,
    leaseIdOnOrigin: () => undefined,
    isHeaded: () => false,
    touch: () => undefined,
    alias: () => undefined,
    permissionsOf: () => undefined,
    guardLease: (_id: string, decide: Recorded['guard']) => {
      recorded.guard = decide;
      return Promise.resolve(true);
    },
  } as unknown as BrowserPool;
  return recorded;
}

/** Every leased tab reads as connected, so acquire's readiness wait resolves at once. */
const depsWith = (pool: BrowserPool, nonces: SessionNonces): ToolDeps =>
  ({
    sessions: { get: () => ({ id: 'live' }), all: () => [] },
    pool,
    nonces,
    bridgePort: 4400,
    linkedCloud: () => Promise.resolve({ url: 'https://cloud.example.com', apiKey: 'rk_test' }),
  }) as unknown as ToolDeps;

function serveTicket(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: 200 <= status && status < 300,
        status,
        json: () => Promise.resolve(body),
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const production = { workspaceId: 'ws_staff', scope: HelloScope.ACT };

describe('reticle_lease acquire with production', () => {
  it('opens the site carrying the ticket and guards its requests', async () => {
    serveTicket(200, { ticket: 'signed-ticket' });
    const recorded = fakePool();
    const result = (await acquire(depsWith(recorded.pool, nonces()), {
      url: SITE,
      production,
    })) as { production?: { scope: string } };
    const opened = new URL(recorded.acquired[0] ?? '');
    expect(opened.origin).toBe('https://app.example.com');
    expect(opened.searchParams.get(PRODUCTION_ACTIVATE_PARAM)).toBe('signed-ticket');
    expect(recorded.guard?.('POST', 'https://app.example.com/v1/invites')).toContain(
      PRODUCTION_REFUSAL_PREFIX,
    );
    expect(recorded.guard?.('GET', 'https://app.example.com/v1/runs')).toBeUndefined();
    expect(result.production?.scope).toBe(HelloScope.ACT);
  });

  // A host embedding the engine (a hosted verifier with its own bridge) supplies its cloud link
  // through ToolDeps.linkedCloud and its bridge through bridgePort: no cloud.json is read.
  it("asks the host's cloud for a ticket bound to the site origin and the host's bridge", async () => {
    serveTicket(200, { ticket: 'signed-ticket' });
    const recorded = fakePool();
    const deps = {
      ...depsWith(recorded.pool, nonces()),
      bridgePort: 51234,
      linkedCloud: () => Promise.resolve({ url: 'https://api.host.example', apiKey: 'rk_host' }),
    } as unknown as ToolDeps;
    await acquire(deps, { url: SITE, production });
    const call = vi.mocked(fetch).mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(call[0]).toBe(`https://api.host.example${PRODUCTION_TICKET_PATH}`);
    expect(call[1].headers['authorization']).toBe('Bearer rk_host');
    expect(JSON.parse(call[1].body)).toMatchObject({
      origin: 'https://app.example.com',
      bridge: `ws://${LOOPBACK_HOST}:51234${RETICLE_WS_PATH}`,
      bridgePort: 51234,
    });
  });

  // A public page reaching ws://127.0.0.1 needs Local Network Access, and a leased browser has no
  // person to answer the prompt. Granted on this lease's origin only, not by a launch flag: a second
  // --disable-features would replace the list Playwright launches with.
  it('grants local network access on the site origin, beside what the caller asked for', async () => {
    serveTicket(200, { ticket: 't' });
    const recorded = fakePool();
    await acquire(depsWith(recorded.pool, nonces()), {
      url: SITE,
      production,
      permissions: ['clipboard-read'],
    });
    expect(recorded.permissions[0]).toEqual(['clipboard-read', 'local-network-access']);
  });

  it('says the server does not offer production mode, and opens nothing', async () => {
    serveTicket(404, {});
    const recorded = fakePool();
    await expect(
      acquire(depsWith(recorded.pool, nonces()), { url: SITE, production }),
    ).rejects.toThrow(PRODUCTION_MODE_NOT_OFFERED);
    expect(recorded.acquired).toEqual([]);
  });
});

function nonces(): SessionNonces {
  return new SessionNonces({ clock: () => 1_000 });
}
