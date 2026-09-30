import { beforeEach, describe, expect, it } from 'vitest';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import {
  BlindSpotKind,
  ChannelId,
  InstrumentationGapKind,
  ReticleCommand,
  ReticleTool,
  type CommandResult,
} from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { createFakeSession } from '@/portal/session/fake-session.js';
import { resetGapNovelty } from '@/surface/tools/gap-novelty.js';

/**
 * #1146, end to end through `reticle_assert`.
 *
 * A `state` predicate is answered by reading the store on demand (STATE_READ), so a store registered
 * as a bare getter — `registerStore('app', () => state)` — passes it with the right values. The
 * same response used to carry a `no-store-registered` gap saying "no store is registered" and
 * recommending the call the app had already made.
 *
 * The page declares the `state` channel whenever ANY store is registered, and the React adapter
 * always registers Reticle's own `__reticle_renders` getter. So the channel cannot tell an app's
 * getter from Reticle's, and the gap must not claim to know which one it is looking at.
 */
function depsFor(stores: Record<string, unknown>, sessionId: string): ToolDeps {
  const session = createFakeSession(
    {
      bufferHealth: () => ({ total: 5, dropped: 0 }),
      command: (name: string): Promise<CommandResult> =>
        Promise.resolve({
          ok: true,
          kind: 'command_result' as const,
          id: 'c1',
          result: ReticleCommand.STATE_READ === name ? { stores } : {},
        }),
      blindSpots: () => ({ [BlindSpotKind.UNWATCHED_STATE]: 1 }),
      elapsed: () => 1000,
      health: () => ({ lastSeenMs: 5, throttled: false, focused: true, hidden: false }),
      hasCapabilities: true,
      channels: [ChannelId.UI, ChannelId.NET, ChannelId.LOG, ChannelId.STATE],
    },
    { sessionId },
  );
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return {
    sessions: sessions as SessionManager,
    recordings: new RecordingStore(),
  } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

interface Gap {
  kind: string;
  missing: string;
  cost: string;
  fix: string;
}

async function storeGap(stores: Record<string, unknown>, sessionId: string) {
  const result = (await tool(ReticleTool.ASSERT).handler(depsFor(stores, sessionId), {
    predicate: { kind: 'state', path: 'total', equals: 3 },
    timeout_ms: 0,
  })) as { pass?: boolean; instrumentationGaps?: Gap[] };
  const gap = result.instrumentationGaps?.find(
    (g) => InstrumentationGapKind.NO_STORE_REGISTERED === g.kind,
  );
  return { pass: result.pass, gap };
}

describe('a state assertion over a store with no subscribe (#1146)', () => {
  beforeEach(() => resetGapNovelty());

  it('does not tell an app whose getter it just read that no store is registered', async () => {
    const { pass, gap } = await storeGap({ app: { total: 3 } }, 'bare-getter');
    expect(pass).toBe(true);
    expect(gap?.missing).not.toContain('no store is registered');
    expect(gap?.missing).toContain('subscribable');
    // The assertion was answered from the store, not from the DOM.
    expect(gap?.cost).not.toContain('DOM');
    expect(gap?.fix).toContain('registerStore(name, store)');
  });

  it("does not tell a React app whose only store is Reticle's own that a store is registered", async () => {
    const { pass, gap } = await storeGap({ __reticle_renders: { commits: 4 } }, 'react-only');
    expect(pass).toBe(false);
    expect(gap?.missing).not.toMatch(/a store is registered/);
  });
});
