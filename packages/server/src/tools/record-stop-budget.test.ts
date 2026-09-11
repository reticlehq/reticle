import { describe, it, expect } from 'vitest';
import { EventType, REPLAY_PROGRAM_VERSION } from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tools.js';
import type { Session, SessionManager } from '../session/session.js';
import { RecordingStore, type CompiledProgram } from '../flows/recordings.js';

function recordStopTool() {
  const t = READ_TOOLS.find((x) => x.name === ReticleTool.RECORD_STOP);
  if (t === undefined) throw new Error('no reticle_record_stop tool');
  return t;
}

function buildDeps(eventCount: number): ToolDeps {
  const recordings = new RecordingStore();
  recordings.start('test-rec', 0);
  const events = Array.from({ length: eventCount }, (_, i) => ({
    t: i,
    type: EventType.DOM_ADDED,
    sessionId: 's1',
    data: { html: `<div class="item-${String(i)}">content ${String(i)}</div>` },
  }));
  const session = {
    elapsed: () => eventCount,
    eventsSince: () => events,
  } as unknown as Session;
  const sessions = { resolve: () => session } as unknown as SessionManager;
  return { sessions, recordings } as unknown as ToolDeps;
}

describe('reticle_record_stop output budget', () => {
  it('never returns a raw events array — the timeline is omitted by default', async () => {
    const deps = buildDeps(440);
    const result = (await recordStopTool().handler(deps, { recordingName: 'test-rec' })) as Record<
      string,
      unknown
    >;
    expect(result['events']).toBeUndefined();
  });

  it('returns summary counts so the agent knows what happened without the raw timeline', async () => {
    const deps = buildDeps(10);
    const result = (await recordStopTool().handler(deps, { recordingName: 'test-rec' })) as {
      summary?: { total: number; domAdded: number };
    };
    expect(result.summary).toBeDefined();
    expect(result.summary?.total).toBe(10);
    expect(result.summary?.domAdded).toBe(10);
  });

  it('keeps program, proposedConsequences, and cost in the response', async () => {
    const deps = buildDeps(5);
    const result = (await recordStopTool().handler(deps, { recordingName: 'test-rec' })) as {
      program?: CompiledProgram;
      cost?: { events: number };
      recordingName?: string;
    };
    expect(result.recordingName).toBe('test-rec');
    expect(result.program).toBeDefined();
    expect(result.program?.version).toBe(REPLAY_PROGRAM_VERSION);
    expect(result.cost).toBeDefined();
    expect(result.cost?.events).toBe(5);
  });

  it('stays under 4KB for a 440-event recording (was ~63KB before the fix)', async () => {
    const deps = buildDeps(440);
    const result = await recordStopTool().handler(deps, { recordingName: 'test-rec' });
    const size = JSON.stringify(result).length;
    expect(size).toBeLessThan(4000);
  });

  it('says the timeline was omitted and where to get it, rather than dropping it silently', async () => {
    // The trim is right; a silent trim is not. A field that simply stops appearing reads the same as
    // one this version never had, and an agent cannot ask for something it does not know exists.
    const deps = buildDeps(440);
    const result = (await recordStopTool().handler(deps, { recordingName: 'test-rec' })) as {
      timeline_omitted?: string;
    };
    expect(result.timeline_omitted).toBeDefined();
    expect(result.timeline_omitted).toContain('440');
    expect(result.timeline_omitted).toContain('reticle_observe');
  });

  it('does not claim a timeline was omitted when nothing was recorded', async () => {
    const deps = buildDeps(0);
    const result = (await recordStopTool().handler(deps, { recordingName: 'test-rec' })) as {
      timeline_omitted?: string;
    };
    expect(result.timeline_omitted).toBeUndefined();
  });

  it('reports window_ms from the reaction without the heavy events payload', async () => {
    const deps = buildDeps(20);
    const result = (await recordStopTool().handler(deps, { recordingName: 'test-rec' })) as {
      window_ms?: number;
    };
    expect(result.window_ms).toBeDefined();
    expect(result.window_ms).toBe(20);
  });
});
