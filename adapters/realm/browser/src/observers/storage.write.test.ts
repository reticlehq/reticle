import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installStorage } from './storage.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

describe('installStorage — storage write events', () => {
  let events: Captured[];
  let teardown: () => void;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    events = [];
    teardown = installStorage((type, data) => events.push({ type, data }));
  });
  afterEach(() => {
    teardown();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('emits a STORAGE_CHANGE with old + new on setItem', () => {
    localStorage.setItem('cart', '2-items');
    localStorage.setItem('cart', '3-items');
    const changes = events.filter((e) => e.type === EventType.STORAGE_CHANGE);
    expect(changes).toHaveLength(2);
    expect(changes[1]?.data).toMatchObject({
      area: 'local',
      key: 'cart',
      old: '2-items',
      new: '3-items',
    });
  });

  it('redacts the value of a credential-bearing key', () => {
    localStorage.setItem('auth_token', 'tok-secret-123');
    const change = events.find((e) => e.type === EventType.STORAGE_CHANGE);
    expect(change?.data['new']).toBe('[REDACTED]');
    expect(change?.data['new']).not.toContain('secret');
  });

  it('distinguishes session from local by the storage instance', () => {
    sessionStorage.setItem('view', 'overview');
    expect(events[0]?.data['area']).toBe('session');
  });

  it('emits a change with no `new` field on removeItem (signals removal)', () => {
    localStorage.setItem('k', 'v');
    events.length = 0;
    localStorage.removeItem('k');
    const change = events.find((e) => e.type === EventType.STORAGE_CHANGE);
    expect(change?.data).toMatchObject({ area: 'local', key: 'k', old: 'v' });
    expect(change?.data['new']).toBeUndefined();
  });

  it('stops emitting after teardown (fully reversible)', () => {
    teardown();
    events.length = 0;
    localStorage.setItem('after', 'x');
    expect(events).toHaveLength(0);
  });

  it('emits a removal per key on clear() — the common logout path', () => {
    // localStorage.clear() is how most apps log out; it used to emit NOTHING, so "logout cleared the
    // session" was unverifiable from the write path.
    localStorage.setItem('a', '1');
    localStorage.setItem('auth_token', 'tok-secret-123');
    events.length = 0;
    localStorage.clear();
    const changes = events.filter((e) => e.type === EventType.STORAGE_CHANGE);
    expect(changes).toHaveLength(2);
    for (const c of changes) {
      expect(c.data['area']).toBe('local');
      expect(c.data['new']).toBeUndefined(); // removal
    }
    const authChange = changes.find((c) => 'auth_token' === c.data['key']);
    expect(authChange?.data['old']).toBe('[REDACTED]'); // credential redacted, not leaked on clear
    expect(localStorage.length).toBe(0); // the app's clear still happened
  });

  it('restores clear() on teardown (fully reversible)', () => {
    teardown();
    events.length = 0;
    localStorage.setItem('k', 'v');
    localStorage.clear();
    expect(events).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });
});
