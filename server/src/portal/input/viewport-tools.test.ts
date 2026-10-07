import { describe, expect, it } from 'vitest';
import {
  CDP_NO_PROVIDER_REASON,
  CDP_NO_PROVIDER_RECOMMENDATION,
  InputMode,
  VIEWPORT_NO_PROVIDER_RECOMMENDATION,
} from '@reticlehq/core';
import { VIEWPORT_TOOLS } from './viewport-tools.js';
import { ReticleTool } from '@reticlehq/core';
import type { RealInputProvider } from './real-input.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { MERGE_PLANS, MERGED_TOOLS, TOOLS, type ToolDeps } from '@/surface/tools/tools.js';

function tool() {
  const t = VIEWPORT_TOOLS.find((x) => x.name === ReticleTool.VIEWPORT);
  if (t === undefined) throw new Error('no reticle_viewport tool');
  return t;
}

function depsWith(realInput: RealInputProvider | undefined, pool?: ToolDeps['pool']): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => ({ url: 'http://localhost:5173/app' }) as never,
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
    } as ToolDeps['pool'];

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
