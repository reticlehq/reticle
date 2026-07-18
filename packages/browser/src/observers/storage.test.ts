import { describe, it, expect, beforeEach } from 'vitest';
import { readStorage, type StorageSnapshot } from './storage.js';

describe('readStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('reads local + session and redacts sensitive keys', () => {
    const tokenValue = 'tok-abcdef123456';
    localStorage.setItem('cart', '3-items');
    localStorage.setItem('auth_token', tokenValue); // sensitive key → redacted
    sessionStorage.setItem('view', 'overview');
    const snap = readStorage() as StorageSnapshot;
    expect(snap.local['cart']).toBe('3-items');
    expect(snap.local['auth_token']).toBe('[REDACTED]');
    expect(snap.local['auth_token']).not.toBe(tokenValue);
    expect(snap.session['view']).toBe('overview');
  });

  it('scopes to a single area (local, session, cookies)', () => {
    localStorage.setItem('k', 'v');
    sessionStorage.setItem('s', 'w');
    document.cookie = 'scopecookie=present';
    expect(readStorage('local')).toEqual({ k: 'v' });
    expect(readStorage('session')).toEqual({ s: 'w' });
    expect(readStorage('cookies')).toMatchObject({ scopecookie: 'present' });
  });

  it('reads cookies, redacts sensitive cookie names, and url-decodes values', () => {
    const cookieVal = 'sess-xyz-abcdef123';
    document.cookie = 'theme=dark';
    document.cookie = 'greeting=hello%20world';
    document.cookie = `session_token=${cookieVal}`; // sensitive → redacted
    const cookies = readStorage('cookies') as Record<string, string>;
    expect(cookies['theme']).toBe('dark');
    expect(cookies['greeting']).toBe('hello world'); // decodeURIComponent applied
    expect(cookies['session_token']).toBe('[REDACTED]');
    expect(cookies['session_token']).not.toBe(cookieVal);
  });

  it('a throwing storage area returns {} instead of crashing the whole read', () => {
    const realLocal = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage disabled');
      },
    });
    try {
      const snap = readStorage() as StorageSnapshot;
      expect(snap.local).toEqual({}); // caught, empty — session + cookies still read
      expect(snap).toHaveProperty('session');
      expect(snap).toHaveProperty('cookies');
    } finally {
      if (realLocal) Object.defineProperty(window, 'localStorage', realLocal);
    }
  });
});
