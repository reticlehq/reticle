import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import type { ToolDeps } from './tools.js';
import { pinSession, reticleToolset } from './harness-toolset.js';

/** The dependency bag is never reached: every assertion here is about the ADVERTISED surface. */
const NO_DEPS = {} as unknown as ToolDeps;

function names(options?: Parameters<typeof reticleToolset>[1]): string[] {
  return reticleToolset(NO_DEPS, options).tools.map((tool) => tool.name);
}

describe('the surface the harness drives', () => {
  it('is the one a user gets, so what a drive proves is what an agent could prove', () => {
    expect(names()).toContain(ReticleTool.ACT_AND_WAIT);
    expect(names()).toContain(ReticleTool.SNAPSHOT);
    expect(names()).toContain(ReticleTool.OBSERVE);
  });

  it('adds recording, because an unrecorded drive has to be paid for again every run', () => {
    expect(names()).toContain(ReticleTool.RECORD);
    expect(names()).toContain(ReticleTool.FLOW_SAVE);
  });

  it('drops the human feedback channel, which a looping model would drown', () => {
    expect(names()).not.toContain(ReticleTool.FEEDBACK);
  });

  it('never asks the model for the session it was given', () => {
    const advertised = reticleToolset(NO_DEPS, { sessionId: 'tab-1' }).tools;
    for (const tool of advertised) {
      const properties = tool.inputSchema['properties'];
      expect(Object.keys(properties as Record<string, unknown>)).not.toContain('sessionId');
    }
  });

  it('advertises real JSON Schema, because a model cannot call a shape it cannot read', () => {
    const snapshot = reticleToolset(NO_DEPS).tools.find(
      (tool) => ReticleTool.SNAPSHOT === tool.name,
    );
    expect(snapshot?.inputSchema['type']).toBe('object');
    expect(snapshot?.inputSchema['properties']).toBeTypeOf('object');
  });

  it('keeps the recursive predicate whole — it is the argument that proves things', () => {
    const actAndWait = reticleToolset(NO_DEPS).tools.find(
      (tool) => ReticleTool.ACT_AND_WAIT === tool.name,
    );
    // Inlining a recursive schema is impossible, so a converter forbidden to emit `$ref` degrades
    // `until` to `any` — and the model is then guessing the one shape that decides a verdict.
    expect(JSON.stringify(actAndWait?.inputSchema)).toContain('$ref');
  });

  it('honours an explicit subset, for a drive with one job', () => {
    expect(names({ only: [ReticleTool.SNAPSHOT] })).toEqual([ReticleTool.SNAPSHOT]);
  });
});

describe('pinning the drive to its own tab', () => {
  it('stamps the session the drive opened onto every call', () => {
    expect(pinSession({ ref: 'e1' }, 'tab-1')).toEqual({ ref: 'e1', sessionId: 'tab-1' });
  });

  it('leaves a deliberate cross-tab call alone', () => {
    expect(pinSession({ sessionId: 'other' }, 'tab-1')).toEqual({ sessionId: 'other' });
  });

  it('changes nothing when the drive pinned no session', () => {
    expect(pinSession({ ref: 'e1' }, undefined)).toEqual({ ref: 'e1' });
  });
});
