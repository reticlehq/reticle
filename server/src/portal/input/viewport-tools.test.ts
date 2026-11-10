import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  CDP_NO_PROVIDER_REASON,
  CDP_NO_PROVIDER_RECOMMENDATION,
  InputMode,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  VIEWPORT_NO_PROVIDER_RECOMMENDATION,
  type HelloMessage,
} from '@reticlehq/core';
import { VIEWPORT_TOOLS, leaseEmulationOf } from './viewport-tools.js';
import { HEADLESS_VIEWPORT } from '@/chromium-launch-options.js';
import { contextEmulationOf } from '@/portal/pool/lease-emulation.js';
import { ReticleTool } from '@reticlehq/core';
import type { RealInputProvider } from './real-input.js';
import { Session } from '@/portal/session/session.js';
import { SessionManager } from '@/portal/session/session-manager.js';
import { MERGE_PLANS, MERGED_TOOLS, TOOLS, type ToolDeps } from '@/surface/tools/tools.js';

function tool() {
  const t = VIEWPORT_TOOLS.find((x) => x.name === ReticleTool.VIEWPORT);
  if (t === undefined) {
    throw new Error('no reticle_viewport tool');
  }
  return t;
}

function depsWith(realInput: RealInputProvider | undefined, pool?: ToolDeps['pool']): ToolDeps {
  const session = { url: 'http://localhost:5173/app' } as never;
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    resolveServing: () => Promise.resolve(session),
  };
  return {
    sessions: sessions as SessionManager,
    realInput,
    pool,
  } as unknown as ToolDeps;
}

interface ViewportResult {
  applied: boolean;
  width: number;
  height: number;
  ok?: boolean;
  reason?: string;
  recommendation?: string;
}

describe('reticle_viewport tool', () => {
  it('returns the no-provider envelope when nothing is driving the page', async () => {
    const res = (await tool().handler(depsWith(undefined), {
      width: 1280,
      height: 800,
    })) as ViewportResult;
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(false);
    // NOT the visual code: this tool mocks requests / resizes windows, and an agent gating on
    // "no-visual-provider" here would be matching on a false statement about what it asked for.
    expect(res.reason).toBe(CDP_NO_PROVIDER_REASON);
  });
  it('tells a refused caller that a leased tab can be resized (#1273)', async () => {
    const res = (await tool().handler(depsWith(undefined), {
      width: 1280,
      height: 800,
    })) as ViewportResult;
    expect(res.applied).toBe(false);
    expect(res.recommendation).toBe(VIEWPORT_NO_PROVIDER_RECOMMENDATION);
    // The route is named the way a caller can reach it: neither tool is on the default surface, so
    // it goes through `reticle_run`, and the tool + action it names must be ones that really exist.
    expect(res.recommendation).toContain(ReticleTool.RUN);
    expect(TOOLS.some((t) => t.name === ReticleTool.VIEWPORT)).toBe(true);
    expect(MERGED_TOOLS.some((t) => t.name === ReticleTool.LEASE)).toBe(true);
    const leasePlan = MERGE_PLANS.find((p) => p.name === ReticleTool.LEASE);
    expect(leasePlan?.members['acquire']).toBe(ReticleTool.LEASE_ACQUIRE);
    expect(res.recommendation).toContain(`reticle_run { tool: "${ReticleTool.LEASE}"`);
    expect(res.recommendation).toContain('action: "acquire"');
    // The next call after the acquire is this tool again, aimed at the leased tab.
    expect(res.recommendation).toContain(ReticleTool.VIEWPORT);
    expect(res.recommendation).toContain('sessionId');
    // The human routes are still there, behind the lease, for resizing the tab already open.
    expect(res.recommendation).toContain('reticle drive');
    expect(res.recommendation).toContain('RETICLE_CDP_URL');
  });
  it('still suggests the lease when a pool exists but cannot resize this session', async () => {
    const pool = {
      setViewportLease: () => Promise.resolve(false),
    } as unknown as ToolDeps['pool'];
    const res = (await tool().handler(depsWith(undefined, pool), {
      width: 390,
      height: 844,
    })) as ViewportResult;
    expect(res).toMatchObject({ applied: false, ok: false, reason: CDP_NO_PROVIDER_REASON });
    expect(res.recommendation).toBe(VIEWPORT_NO_PROVIDER_RECOMMENDATION);
  });
  it('leaves the shared no-provider recommendation alone for other tools', () => {
    // reticle_network_mock shares this one; the viewport-specific text must not leak into it.
    expect(CDP_NO_PROVIDER_RECOMMENDATION).not.toContain('reticle_lease');
    expect(VIEWPORT_NO_PROVIDER_RECOMMENDATION).not.toBe(CDP_NO_PROVIDER_RECOMMENDATION);
  });
  it('uses the lease when no CDP provider is available', async () => {
    let captured:
      | {
          sessionId: string;
          size: { width: number; height: number };
        }
      | undefined;

    const pool = {
      setViewportLease: (sessionId: string, size: { width: number; height: number }) => {
        captured = { sessionId, size };
        return Promise.resolve(true);
      },
      viewportOfLease: () => Promise.resolve(undefined),
    } as unknown as ToolDeps['pool'];

    const res = (await tool().handler(depsWith(undefined, pool), {
      width: 390,
      height: 844,
    })) as ViewportResult;

    expect(res).toMatchObject({
      applied: true,
      width: 390,
      height: 844,
    });

    expect(captured?.size).toEqual({
      width: 390,
      height: 844,
    });
  });

  it('pins the viewport on the driven page and echoes the size', async () => {
    let captured: { url: string; size: { width: number; height: number } } | undefined;
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () =>
        Promise.resolve({ performed: true, center: { cx: 0, cy: 0 }, inputMode: InputMode.REAL }),
      setViewport: (url: string, size: { width: number; height: number }) => {
        captured = { url, size };
        return Promise.resolve(true);
      },
    } as unknown as RealInputProvider;

    const res = (await tool().handler(depsWith(provider), {
      width: 1280,
      height: 800,
    })) as ViewportResult;
    expect(res).toMatchObject({ applied: true, width: 1280, height: 800 });
    expect(captured?.url).toBe('http://localhost:5173/app');
    expect(captured?.size).toEqual({ width: 1280, height: 800 });
  });

  it('clamps out-of-range / non-numeric dimensions into sane bounds', async () => {
    let captured: { width: number; height: number } | undefined;
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () =>
        Promise.resolve({ performed: true, center: { cx: 0, cy: 0 }, inputMode: InputMode.REAL }),
      setViewport: (_url: string, size: { width: number; height: number }) => {
        captured = size;
        return Promise.resolve(true);
      },
    } as unknown as RealInputProvider;

    await tool().handler(depsWith(provider), { width: 5, height: 999999 });
    expect(captured?.width).toBe(64); // below MIN_DIM → clamped up
    expect(captured?.height).toBe(10000); // above MAX_DIM → clamped down
  });
});

/**
 * prefers-reduced-motion and prefers-color-scheme on a lease, per call. Without them the CSS half
 * of reduced motion and the dark theme could not be checked live on a leased tab at all.
 */
describe('reticle_viewport sets media on a lease', () => {
  const leasePool = (calls: unknown[]): ToolDeps['pool'] =>
    ({
      setViewportLease: (_id: string, size: unknown) => {
        calls.push({ size });
        return Promise.resolve(true);
      },
      emulateLease: (_id: string, media: unknown) => {
        calls.push({ media });
        return Promise.resolve(true);
      },
      viewportOfLease: () => Promise.resolve(undefined),
    }) as unknown as ToolDeps['pool'];

  it('sets reduced motion and a dark scheme without resizing when no size is given', async () => {
    const calls: unknown[] = [];
    const res = (await tool().handler(depsWith(undefined, leasePool(calls)), {
      reducedMotion: 'reduce',
      colorScheme: 'dark',
    })) as Record<string, unknown>;

    expect(res['applied']).toBe(true);
    expect(res['reducedMotion']).toBe('reduce');
    expect(res['colorScheme']).toBe('dark');
    expect(calls).toEqual([{ media: { reducedMotion: 'reduce', colorScheme: 'dark' } }]);
  });

  it('answers the size the lease already has when only media is given (#1902)', async () => {
    const pool = {
      emulateLease: () => Promise.resolve(true),
      viewportOfLease: () => Promise.resolve({ width: 390, height: 844 }),
    } as unknown as ToolDeps['pool'];
    const res = (await tool().handler(depsWith(undefined, pool), {
      colorScheme: 'dark',
    })) as Record<string, unknown>;

    expect(res['applied']).toBe(true);
    expect(res['colorScheme']).toBe('dark');
    expect(res['width']).toBe(390);
    expect(res['height']).toBe(844);
  });

  it('leaves the size out when only media is given and the lease size cannot be read (#1902)', async () => {
    const res = (await tool().handler(depsWith(undefined, leasePool([])), {
      colorScheme: 'dark',
    })) as Record<string, unknown>;

    expect(res['applied']).toBe(true);
    expect(res).not.toHaveProperty('width');
    expect(res).not.toHaveProperty('height');
  });

  it('resizes and sets media in one call', async () => {
    const calls: unknown[] = [];
    await tool().handler(depsWith(undefined, leasePool(calls)), {
      width: 390,
      height: 844,
      colorScheme: 'light',
    });
    expect(calls).toEqual([
      { size: { width: 390, height: 844 } },
      { media: { colorScheme: 'light' } },
    ]);
  });

  it('says it did not apply media on a page that is not a lease', async () => {
    const res = (await tool().handler(depsWith(undefined), {
      reducedMotion: 'reduce',
    })) as Record<string, unknown>;
    expect(res['applied']).toBe(false);
    expect(res['ok']).toBe(false);
  });
});

/**
 * `reticle_viewport { sessionId: <lease> }` resized the driven tab and answered `applied: true`
 * while the leased tab kept its width. An agent then read desktop boxes as mobile ones.
 */
describe('reticle_viewport on a leased tab', () => {
  const LEASE = 'lease-1';
  const MOBILE = { width: 375, height: 812 };

  function leaseDeps(
    driven: RealInputProvider | undefined,
    observed: { width: number; height: number } | undefined,
    resized: string[],
  ): ToolDeps {
    const lease = { id: LEASE, url: 'http://localhost:5173/app' } as never;
    const sessions: Partial<SessionManager> = {
      resolve: () => lease,
      resolveServing: () => Promise.resolve(lease),
    };
    const pool = {
      leaseUrl: (id: string) => (id === LEASE ? 'http://localhost:5173/app' : undefined),
      setViewportLease: (id: string) => {
        resized.push(id);
        return Promise.resolve(true);
      },
      viewportOfLease: () => Promise.resolve(observed),
    } as unknown as ToolDeps['pool'];
    return { sessions: sessions as SessionManager, realInput: driven, pool } as unknown as ToolDeps;
  }

  const drivenProvider = (resized: string[]): RealInputProvider =>
    ({
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true }),
      setViewport: () => {
        resized.push('driven');
        return Promise.resolve(true);
      },
    }) as unknown as RealInputProvider;

  it('resizes the lease, and not the driven page, when the session is a lease', async () => {
    const resized: string[] = [];
    const res = (await tool().handler(leaseDeps(drivenProvider(resized), MOBILE, resized), {
      ...MOBILE,
      sessionId: LEASE,
    })) as Record<string, unknown>;
    expect(resized).toEqual([LEASE]);
    expect(res['applied']).toBe(true);
    expect(res['observed']).toEqual(MOBILE);
  });

  it('says applied: false, with the size the page reports, when the page kept its size', async () => {
    const resized: string[] = [];
    const res = (await tool().handler(leaseDeps(undefined, { width: 1280, height: 720 }, resized), {
      ...MOBILE,
      sessionId: LEASE,
    })) as Record<string, unknown>;
    expect(res['applied']).toBe(false);
    expect(res['observed']).toEqual({ width: 1280, height: 720 });
  });
});
// ── A coarse pointer: chosen when the lease opens, refused on a live one (#1903) ──

describe('a lease emulates a pointer', () => {
  it('carries pointer: "coarse" through as its own field, so the context can open with it', () => {
    expect(leaseEmulationOf({ pointer: 'coarse' })).toEqual({ pointer: 'coarse' });
    expect(leaseEmulationOf({ width: 390, height: 844, pointer: 'coarse' })).toEqual({
      viewport: { width: 390, height: 844 },
      pointer: 'coarse',
    });
  });

  it('refuses a pointer it does not know by name', () => {
    expect(() => leaseEmulationOf({ pointer: 'medium' })).toThrow(/emulate\.pointer/);
  });

  it('becomes hasTouch for Playwright, which has no pointer option', () => {
    expect(contextEmulationOf({ pointer: 'coarse' })).toEqual({ hasTouch: true });
    expect(contextEmulationOf({ pointer: 'fine' })).toEqual({ hasTouch: false });
    // No pointer asked for means no touch option at all, not hasTouch: false.
    expect(contextEmulationOf({ colorScheme: 'dark' })).toEqual({ colorScheme: 'dark' });
  });

  it('refuses reticle_viewport { pointer } on a live lease instead of ignoring it', async () => {
    const calls: unknown[] = [];
    const pool = {
      emulateLease: (_id: string, media: unknown) => {
        calls.push(media);
        return Promise.resolve(true);
      },
      viewportOfLease: () => Promise.resolve({ width: 1280, height: 720 }),
      setViewportLease: () => Promise.resolve(true),
    } as unknown as ToolDeps['pool'];

    const res = (await tool().handler(depsWith(undefined, pool), {
      pointer: 'coarse',
      width: 390,
      height: 844,
    })) as Record<string, unknown>;

    expect(res['applied']).toBe(false);
    expect(res['ok']).toBe(false);
    expect(String(res['recommendation'])).toContain('emulate.pointer');
    // Nothing was applied on the way to the refusal: no resize, no media call.
    expect(calls).toEqual([]);
  });
});

// ── A lease that names one side keeps the default for the other (#2052) ──

describe('a lease that names only one side of the viewport', () => {
  it('fills the other side from the headless default, not from 1280 by 720', () => {
    expect(leaseEmulationOf({ width: 390 })).toEqual({
      viewport: { width: 390, height: HEADLESS_VIEWPORT.height },
    });
    expect(leaseEmulationOf({ height: 600 })).toEqual({
      viewport: { width: HEADLESS_VIEWPORT.width, height: 600 },
    });
  });
});

// ── An id-less call picks the one session that can serve it (#1959) ──

/**
 * One lease (with CDP) and one SDK-only tab in scope. An id-less reticle_viewport resolved to the
 * focused SDK-only tab and refused with no-cdp-provider, while the lease could resize.
 */
describe('reticle_viewport without a sessionId', () => {
  const LEASE = 'lease-1';
  const SDK_ONLY = 'tab-1';
  /** The agent that took the lease. */
  const AGENT = 'agent-1';
  /** An agent on the same daemon that holds no lease. */
  const OTHER_AGENT = 'agent-2';
  const APP_URL = 'http://localhost:5173/app';
  const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

  /** A connected session on a fixed clock, so resolve() scores it the same on every run. */
  function sessionOf(id: string, focused: boolean): Session {
    const hello: HelloMessage = {
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: id,
      url: APP_URL,
      title: id,
      adapters: [],
      hasCapabilities: false,
    };
    const session = new Session(hello, fakeSocket, () => 0);
    session.touch();
    session.applyHealth(false, focused);
    return session;
  }

  /**
   * The focused SDK-only tab and AGENT's lease, called by `caller`. `resized` collects the ids
   * the pool resized.
   */
  function twoTabs(caller: string): { deps: ToolDeps; resized: string[] } {
    const sessions = new SessionManager();
    // The SDK-only tab has the focus, so resolve() picks it today.
    sessions.add(sessionOf(SDK_ONLY, true));
    sessions.add(sessionOf(LEASE, false));

    const resized: string[] = [];
    // Only the lease can be resized, as in the real pool.
    const pool = {
      leaseUrl: (id: string) => (id === LEASE ? APP_URL : undefined),
      setViewportLease: (id: string) => {
        if (id !== LEASE) {
          return Promise.resolve(false);
        }
        resized.push(id);
        return Promise.resolve(true);
      },
      viewportOfLease: () => Promise.resolve(undefined),
      heldBy: (id: string, owner: string | undefined) => id === LEASE && owner === AGENT,
    } as unknown as ToolDeps['pool'];

    // No realInput: nothing drives the page, so only the lease can resize.
    const deps = { sessions, pool, attachId: caller } as unknown as ToolDeps;
    return { deps, resized };
  }

  it('resizes the one lease in scope, not the focused SDK-only tab', async () => {
    const { deps, resized } = twoTabs(AGENT);

    const res = await tool().handler(deps, { width: 390, height: 844 });

    expect(res).toMatchObject({ applied: true, width: 390, height: 844 });
    expect(resized).toEqual([LEASE]);
  });

  it("leaves another agent's lease alone (#1226)", async () => {
    const { deps, resized } = twoTabs(OTHER_AGENT);

    const res = await tool().handler(deps, { width: 390, height: 844 });

    // The lease is AGENT's, so this caller has nothing that can resize, and it is refused.
    expect(res).toMatchObject({ applied: false, reason: CDP_NO_PROVIDER_REASON });
    expect(resized).toEqual([]);
  });
});
