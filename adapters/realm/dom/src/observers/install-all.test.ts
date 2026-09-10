/**
 * Teardown must obey the same rule install does: one observer failing may never stop the others.
 *
 * Install wraps each observer in `guard()`. Teardown ran bare, so ONE throwing disposer left every
 * later one unrun — `fetch`, XHR, `Storage.prototype.*`, `console` and the native dialogs stayed
 * patched forever on a page the SDK had been told to leave.
 */
import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { runTeardowns } from './install-all.js';
import { SdkSite } from './sdk-failure.js';
import type { Emit } from './types.js';

describe('runTeardowns', () => {
  it('runs every teardown even when an earlier one throws', () => {
    const ran: string[] = [];
    const events: Array<{ type: EventType; data: Record<string, unknown> }> = [];
    const emit: Emit = (type, data) => {
      events.push({ type, data });
    };

    runTeardowns(emit, [
      () => ran.push('first'),
      () => {
        throw new Error('disposer exploded');
      },
      () => ran.push('third'),
    ]);

    expect(ran).toEqual(['first', 'third']);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.SDK_FAILED);
    expect(events[0]?.data['site']).toBe(SdkSite.TEARDOWN);
    expect(events[0]?.data['message']).toBe('disposer exploded');
  });

  it('does not throw when the failure report itself cannot be sent', () => {
    expect(() =>
      runTeardowns(() => {
        throw new Error('emit is dead too');
      }, [
        () => {
          throw new Error('disposer exploded');
        },
      ]),
    ).not.toThrow();
  });
});
