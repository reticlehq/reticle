import { describe, expect, it } from 'vitest';
import type { FlowExpect } from '@reticle/protocol';
import type { EvalResult, FlowReplaySession, Predicate, WaitForSignal } from '@reticle/server';
import { assertSuccess, successToPredicate } from './success-assert.js';

/** A no-op session — assertSuccess delegates all evaluation to the injected waitForSignal. */
const fakeSession: FlowReplaySession = {
  command: () => Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} }),
  eventsSince: () => [],
  onEvent: () => () => {},
  elapsed: () => 0,
};

/** Records the predicate + timeout it was handed, and answers with a scripted verdict. */
function recordingWait(verdict: EvalResult): {
  wait: WaitForSignal;
  calls: { predicate: Predicate; timeoutMs: number }[];
} {
  const calls: { predicate: Predicate; timeoutMs: number }[] = [];
  const wait: WaitForSignal = (_session, predicate, timeoutMs) => {
    calls.push({ predicate, timeoutMs });
    return Promise.resolve(verdict);
  };
  return { wait, calls };
}

describe('successToPredicate', () => {
  it('compiles a signal success into a signal predicate', () => {
    const success: FlowExpect = { signal: 'flow:done' };
    const p = successToPredicate(success, new Set());
    expect(p).toEqual({ kind: 'signal', name: 'flow:done' });
  });

  it('threads signalData into the signal predicate dataMatches', () => {
    const success: FlowExpect = { signal: 'flow:done', signalData: { ok: true } };
    const p = successToPredicate(success, new Set());
    expect(p).toEqual({ kind: 'signal', name: 'flow:done', dataMatches: { ok: true } });
  });

  it('compiles a net success into a net predicate', () => {
    const success: FlowExpect = { net: { method: 'POST', urlContains: '/save', status: 200 } };
    const p = successToPredicate(success, new Set());
    expect(p).toEqual({ kind: 'net', method: 'POST', urlContains: '/save', status: 200 });
  });

  it('compiles an element testid success into an element predicate', () => {
    const success: FlowExpect = { element: { testid: 'saved-badge' } };
    const p = successToPredicate(success, new Set());
    expect(p).toEqual({ kind: 'element', query: { testid: 'saved-badge' } });
  });

  it('combines multiple fields under allOf', () => {
    const success: FlowExpect = { signal: 'flow:done', element: { testid: 'saved-badge' } };
    const p = successToPredicate(success, new Set());
    expect(p?.kind).toBe('allOf');
  });

  it('returns undefined when the only success field is a dynamic-marked element', () => {
    const success: FlowExpect = { element: { testid: 'ai-output' } };
    const p = successToPredicate(success, new Set(['ai-output']));
    expect(p).toBeUndefined();
  });

  it('drops a dynamic element but keeps the non-dynamic signal', () => {
    const success: FlowExpect = { signal: 'flow:done', element: { testid: 'ai-output' } };
    const p = successToPredicate(success, new Set(['ai-output']));
    expect(p).toEqual({ kind: 'signal', name: 'flow:done' });
  });
});

describe('assertSuccess', () => {
  it('passes when success is undefined (no condition declared)', async () => {
    const { wait, calls } = recordingWait({ pass: false });
    const r = await assertSuccess(fakeSession, undefined, new Set(), wait, 4000);
    expect(r.pass).toBe(true);
    expect(calls).toHaveLength(0); // never even consulted the waiter
  });

  it('passes vacuously when every success field was dynamic-skipped', async () => {
    const { wait, calls } = recordingWait({ pass: false });
    const success: FlowExpect = { element: { testid: 'ai-output' } };
    const r = await assertSuccess(fakeSession, success, new Set(['ai-output']), wait, 4000);
    expect(r.pass).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('passes when the injected waiter reports the predicate held', async () => {
    const { wait, calls } = recordingWait({ pass: true, evidence: { name: 'flow:done' } });
    const success: FlowExpect = { signal: 'flow:done' };
    const r = await assertSuccess(fakeSession, success, new Set(), wait, 4000);
    expect(r.pass).toBe(true);
    expect(calls[0]?.predicate).toEqual({ kind: 'signal', name: 'flow:done' });
  });

  it('fails with the waiter evidence when the predicate never held', async () => {
    const { wait } = recordingWait({
      pass: false,
      failureReason: "signal 'flow:done' fired 1x but data didn't match",
      evidence: { nearMiss: [{ stale: true }] },
    });
    const success: FlowExpect = { signal: 'flow:done' };
    const r = await assertSuccess(fakeSession, success, new Set(), wait, 4000);
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('flow:done');
    expect(r.evidence).toEqual({ nearMiss: [{ stale: true }] });
  });

  it('passes the injected timeout through to the waiter (never wall-clock)', async () => {
    const { wait, calls } = recordingWait({ pass: true });
    const success: FlowExpect = { signal: 'flow:done' };
    await assertSuccess(fakeSession, success, new Set(), wait, 10);
    expect(calls[0]?.timeoutMs).toBe(10);
  });
});
