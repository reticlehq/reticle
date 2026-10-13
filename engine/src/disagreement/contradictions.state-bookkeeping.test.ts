import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'state-bookkeeping', data };
}

const stateDiff = (old: Record<string, unknown>, value: Record<string, unknown>): ReticleEvent =>
  ev(EventType.STATE_CHANGE, { store: 'query-cache', path: 'todos', old, value });

const incompleteStateChange = (): ReticleEvent =>
  ev(EventType.STATE_CHANGE, { store: 'app', path: 'todos' });

const causedKinds = (events: ReticleEvent[]): string[] =>
  findContradictions(events, { actionSince: 0 }).map((contradiction) => contradiction.kind);

describe('state-vs-render and cache bookkeeping', () => {
  it('ignores a timestamp-only refresh of unchanged query data', () => {
    expect(
      causedKinds([
        stateDiff(
          { data: { plan: 'trial' }, dataUpdatedAt: 1 },
          { data: { plan: 'trial' }, dataUpdatedAt: 2 },
        ),
      ]),
    ).not.toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('ignores a fetch-status cycle with unchanged query data', () => {
    const idle = { data: { plan: 'trial' }, fetchStatus: 'idle' };
    const fetching = { data: { plan: 'trial' }, fetchStatus: 'fetching' };

    expect(causedKinds([stateDiff(idle, fetching), stateDiff(fetching, idle)])).not.toContain(
      ContradictionKind.STATE_VS_RENDER,
    );
  });

  it('ignores a stale-status change with unchanged query data', () => {
    expect(
      causedKinds([
        stateDiff(
          { data: { plan: 'trial' }, isStale: false },
          { data: { plan: 'trial' }, isStale: true },
        ),
      ]),
    ).not.toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('keeps genuine data changes eligible for the contradiction', () => {
    expect(
      causedKinds([stateDiff({ data: { plan: 'trial' } }, { data: { plan: 'pro' } })]),
    ).toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('keeps genuine error changes eligible for the contradiction', () => {
    expect(causedKinds([stateDiff({ error: null }, { error: 'request failed' })])).toContain(
      ContradictionKind.STATE_VS_RENDER,
    );
  });

  it('keeps unrecognized state fields eligible for the contradiction', () => {
    expect(
      causedKinds([
        stateDiff({ data: { plan: 'trial' } }, { data: { plan: 'trial' }, retryCount: 1 }),
      ]),
    ).toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('keeps meaningful changes visible in a mixed bookkeeping window', () => {
    expect(
      causedKinds([
        stateDiff(
          { data: { plan: 'trial' }, dataUpdatedAt: 1 },
          { data: { plan: 'trial' }, dataUpdatedAt: 2 },
        ),
        stateDiff({ data: { plan: 'trial' } }, { data: { plan: 'pro' } }),
      ]),
    ).toContain(ContradictionKind.STATE_VS_RENDER);
  });

  it('keeps incomplete state events conservative', () => {
    expect(causedKinds([incompleteStateChange()])).toContain(ContradictionKind.STATE_VS_RENDER);
  });
});
