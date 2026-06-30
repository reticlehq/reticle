import { describe, expect, it } from 'vitest';
import { VisualReason } from '@reticle/protocol';
import { VIEWPORT_TOOLS } from './viewport-tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import type { RealInputProvider } from './real-input.js';
import type { SessionManager } from '../session/session.js';
import type { ToolDeps } from '../tools/tools.js';

function tool() {
  const t = VIEWPORT_TOOLS.find((x) => x.name === ReticleTool.VIEWPORT);
  if (t === undefined) throw new Error('no reticle_viewport tool');
  return t;
}

function depsWith(realInput: RealInputProvider | undefined): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => ({ url: 'http://localhost:5173/app' }) as never,
  };
  return { sessions: sessions as SessionManager, realInput } as unknown as ToolDeps;
}

interface ViewportResult {
  applied: boolean;
  width: number;
  height: number;
  ok?: boolean;
  reason?: string;
}

describe('reticle_viewport tool', () => {
  it('returns the no-provider envelope when nothing is driving the page', async () => {
    const res = (await tool().handler(depsWith(undefined), {
      width: 1280,
      height: 800,
    })) as ViewportResult;
    expect(res.applied).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe(VisualReason.NO_PROVIDER);
  });

  it('pins the viewport on the driven page and echoes the size', async () => {
    let captured: { url: string; size: { width: number; height: number } } | undefined;
    const provider = {
      isAvailableFor: () => Promise.resolve(true),
      perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
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
      perform: () => Promise.resolve({ performed: true, center: { cx: 0, cy: 0 } }),
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
