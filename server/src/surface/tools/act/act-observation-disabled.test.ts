import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { disabledTargetNote, windowNet } from './act-observation.js';

/*
 * From a persona drive: the Harness saved an item, the app cleared the field and disabled Save, and
 * the model clicked Save again declaring a POST. Nothing could follow a click on a disabled button,
 * yet the verdict was "no — observed no calls", a finding against an app that did its job.
 */
describe('a declared consequence after clicking a disabled control', () => {
  it('is undecided, naming the disabled control, when the consequence did not follow', () => {
    expect(disabledTargetNote(false, { enabled: false })).toMatch(/disabled/);
  });

  it('changes nothing when the control was enabled, or when the consequence held', () => {
    expect(disabledTargetNote(false, { enabled: true })).toBeUndefined();
    expect(disabledTargetNote(true, { enabled: false })).toBeUndefined();
    expect(disabledTargetNote(false, undefined)).toBeUndefined();
  });
});

/*
 * An issue page could say "Check failed: a request POST matching /api/saved-items" and not show the
 * request that explains it: nothing carried the failed step's calls. They ride on the check now.
 */
describe("a failed check's requests", () => {
  const net = (data: Record<string, unknown>) =>
    ({ type: EventType.NET_REQUEST, t: 1, seq: 1, data }) as unknown as ReticleEvent;

  it('are the calls of its window: method, url, status, a short body', () => {
    const calls = windowNet([
      net({ method: 'post', url: '/api/saved-items', status: 200, responseBody: '{"ok":true}' }),
      net({ method: 'GET', url: '/@vite/client', status: 200 }),
      net({ method: 'GET', url: '/api/items', status: 500, responseBody: 'x'.repeat(1000) }),
    ]);
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/saved-items',
      status: 200,
      body: '{"ok":true}',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body?.length).toBeLessThanOrEqual(300);
  });
});
