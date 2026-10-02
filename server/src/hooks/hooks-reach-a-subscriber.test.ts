/**
 * A real tool call reaches a real subscriber — the wiring, not the bus.
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────────────────────────
 * Hooks are v3's public extension point: the thing somebody else builds on. `hook-bus.test.ts` and
 * `hook-commands.test.ts` both prove the bus works, and both call `emitHook` DIRECTLY. Nothing
 * called `runTool` and watched for a payload, so nothing tested the two lines that connect the
 * product to the contract:
 *
 *     git grep -n hook-emit -- '*.test.ts'   ->   no output
 *
 * Deleting either `emitVerdictHook` or `emitBugFoundHook` from `invoke-tool.ts` left the whole
 * suite green. That is the shape CLAUDE.md rule 10 exists for — an emitter fails silently, nothing
 * throws, no test reddens, and the data is simply never there — except that here the missing data is
 * somebody else's integration rather than our telemetry.
 *
 * So this drives the dispatcher and asserts the payload arrives, through `onHook`, exactly as a
 * third party would subscribe.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ReticleTool, SessionState } from '@reticlehq/core';
import { HookEvent, type HookPayload } from '@reticlehq/core/hooks';
import { onHook, resetHooks } from './hook-bus.js';
import { runTool } from '@/surface/tools/invoke-tool.js';
import type { ToolDef, ToolDeps } from '@/surface/tools/tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { resetSessionMetrics } from '@/telemetry/session-metrics.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

const ROOT = '/tmp/reticle-hook-wiring/.reticle';
const now = (): number => 0;

function fakeDeps(): ToolDeps {
  const session: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    eventsSince: () => [],
    queryEvents: () => Promise.resolve([]),
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 1, throttled: false, focused: true }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    takeSessionLease: () => undefined,
    ageWarning: () => undefined,
  };
  const fs = createNodeFileSystem();
  return {
    sessions: { resolve: () => session as Session } as unknown as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now }),
    project: new ProjectStore(fs, ROOT, { now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: ROOT,
    now,
  };
}

const stub = (name: string, returns: unknown): ToolDef => ({
  name,
  description: '',
  inputSchema: {},
  handler: () => Promise.resolve(returns),
});

afterEach(() => {
  resetHooks();
  resetSessionMetrics();
});

describe('a tool call reaches a hook subscriber', () => {
  it('a verdict-producing tool emits verdict, carrying what the verdict said', async () => {
    const seen: HookPayload[] = [];
    onHook(HookEvent.VERDICT, (payload) => seen.push(payload));

    await runTool(
      stub(ReticleTool.ACT_AND_WAIT, {
        verified: 'yes',
        because: 'the cart count went 0 -> 1',
        url: 'http://localhost:5173/app',
      }),
      fakeDeps(),
      { sessionId: 'demo' },
    );

    expect(seen, 'no verdict hook fired for a tool that produced a verdict').toHaveLength(1);
    const payload = seen[0] as Record<string, unknown>;
    expect(payload['event']).toBe(HookEvent.VERDICT);
    expect(payload['tool']).toBe(ReticleTool.ACT_AND_WAIT);
    expect(payload['verified']).toBe('yes');
    expect(payload['because']).toBe('the cart count went 0 -> 1');
    // The RESOLVED session, not whatever the result echoed — the dispatcher knows which it drove.
    expect(payload['sessionId']).toBe('demo');
  });

  it('a result carrying a defect emits bug_found, one event per defect', async () => {
    const seen: HookPayload[] = [];
    onHook(HookEvent.BUG_FOUND, (payload) => seen.push(payload));

    await runTool(
      // The real shape a tool returns. `bugsInResult` reads `contradictions` (and `anomalies`, and
      // failed assertions) — an invented `bugs: []` key produced one `assertion-failed` from the
      // `verified: 'no'` instead, which is the code being right and the fixture being wrong.
      stub(ReticleTool.ACT_AND_WAIT, {
        verified: 'yes',
        contradictions: [{ kind: 'state-vs-render' }, { kind: 'request-never-settled' }],
      }),
      fakeDeps(),
      { sessionId: 'demo' },
    );

    expect(seen.map((p) => (p as Record<string, unknown>)['kind'])).toEqual([
      'state-vs-render',
      'request-never-settled',
    ]);
    // A consumer subscribes to bug_found to ask "what was found". One event carrying a list would
    // make them unpack it to answer that.
    for (const payload of seen) {
      expect((payload as Record<string, unknown>)['event']).toBe(HookEvent.BUG_FOUND);
      expect((payload as Record<string, unknown>)['repeat']).toBe(false);
    }
  });

  /*
   * The denominator. Without it, a dispatcher that emitted NOTHING at all would pass the two cases
   * above if they were ever weakened to "at most one" — and it says the emitter is selective rather
   * than firing on everything it sees.
   */
  it('a tool that proved nothing emits no verdict', async () => {
    const seen: HookPayload[] = [];
    onHook(undefined, (payload) => seen.push(payload));
    await runTool(stub(ReticleTool.LOOK, { elements: [] }), fakeDeps(), { sessionId: 'demo' });
    expect(seen).toEqual([]);
  });

  it('a subscriber that throws cannot break the tool call', async () => {
    onHook(HookEvent.VERDICT, () => {
      throw new Error('a consumer of ours is broken');
    });
    const result = await runTool(stub(ReticleTool.ACT_AND_WAIT, { verified: 'yes' }), fakeDeps(), {
      sessionId: 'demo',
    });
    expect((result as Record<string, unknown>)['verified']).toBe('yes');
  });
});
