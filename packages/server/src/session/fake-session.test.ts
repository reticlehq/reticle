/**
 * `createFakeSession` is a complete Session. A new public method on the class is a compile error
 * in fake-session.ts, not a runtime miss in seven unrelated stubs.
 */
import { describe, expect, it } from 'vitest';
import { SessionState } from '@reticlehq/core';
import { createFakeSession } from './fake-session.js';

describe('createFakeSession', () => {
  it('supplies the methods that previously had to be copied into every stub', () => {
    const session = createFakeSession();
    expect(session.lostSince(0)).toBe(false);
    expect(session.bufferHealth()).toEqual({ total: 0, dropped: 0 });
    expect(session.takeSessionLease()).toBeUndefined();
    expect(session.getState()).toBe(SessionState.ACTIVE);
  });

  it('lets a test override only the field it cares about', () => {
    const session = createFakeSession({
      id: 'tab-2',
      lostSince: () => true,
    });
    expect(session.id).toBe('tab-2');
    expect(session.lostSince(0)).toBe(true);
    expect(session.bufferHealth().dropped).toBe(0);
  });
});
