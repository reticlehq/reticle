import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from './tools.js';
import type { DeterminismStep } from '@/portal/pool/determinism.js';

function clockTool() {
  const t = READ_TOOLS.find((x) => x.name === ReticleTool.CLOCK);
  if (t === undefined) {
    throw new Error('no reticle_clock tool');
  }
  return t;
}

function depsWith(step: (id: string, frames: number) => Promise<DeterminismStep | undefined>) {
  const sessions: Partial<SessionManager> = {
    resolve: () => ({ id: 'lease-1', url: 'http://localhost:5173/' }) as never,
  };
  return { sessions, pool: { stepLease: step } } as unknown as ToolDeps;
}

describe('reticle_clock { stepFrames }', () => {
  it('steps the leased page and reports the frame and the virtual time', async () => {
    const asked: [string, number][] = [];
    const res = await clockTool().handler(
      depsWith((id, frames) => {
        asked.push([id, frames]);
        return Promise.resolve({ frame: frames, nowMs: frames * 16 });
      }),
      { stepFrames: 30 },
    );
    expect(asked).toEqual([['lease-1', 30]]);
    expect(res).toEqual({ frozen: true, frame: 30, nowMs: 480 });
  });

  it('refuses by name on a session that is not a deterministic lease', async () => {
    const run = clockTool().handler(
      depsWith(() => Promise.resolve(undefined)),
      { stepFrames: 1 },
    );
    await expect(run).rejects.toThrow(/deterministic lease/);
  });

  it('refuses a frame count outside the bound before it reaches the page', async () => {
    const run = clockTool().handler(
      depsWith(() => Promise.resolve({ frame: 0, nowMs: 0 })),
      { stepFrames: 0 },
    );
    await expect(run).rejects.toThrow();
  });
});
