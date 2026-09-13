import { describe, it, expect, beforeEach } from 'vitest';
import { installStorage, readStorage, type StorageSnapshot } from './storage.js';

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

  it('redacts secret-shaped values (e.g. JWT) even under benign key names', () => {
    const jwtSecret =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const apiKeySecret = 'sk_test_mocktoken1234567890abcdef';

    localStorage.setItem('custom_app_cache', jwtSecret);
    sessionStorage.setItem('cached_payload', `prefix-${apiKeySecret}-suffix`);
    document.cookie = `benign_cookie=${jwtSecret}`;

    const snap = readStorage() as StorageSnapshot;
    expect(snap.local['custom_app_cache']).toBe('[REDACTED]');
    expect(snap.local['custom_app_cache']).not.toContain(jwtSecret);

    expect(snap.session['cached_payload']).toBe('prefix-[REDACTED]-suffix');
    expect(snap.session['cached_payload']).not.toContain(apiKeySecret);

    expect(snap.cookies['benign_cookie']).toBe('[REDACTED]');
    expect(snap.cookies['benign_cookie']).not.toContain(jwtSecret);
  });

  it('preserves legitimate near-miss values that merely resemble a secret', () => {
    const nearMiss1 = 'eyJshort'; // not a 3-part base64 JWT
    const nearMiss2 = 'sk_unknown_prefix_12345'; // not live/test
    const legitimateText = 'standard-user-profile-description';
    const validJson = JSON.stringify({ count: 42, label: 'items_in_cart' });

    localStorage.setItem('description', legitimateText);
    localStorage.setItem('cart_json', validJson);
    localStorage.setItem('near_miss_data', nearMiss1);
    sessionStorage.setItem('fake_key', nearMiss2);

    const snap = readStorage() as StorageSnapshot;
    expect(snap.local['description']).toBe(legitimateText);
    expect(snap.local['cart_json']).toBe(validJson);
    expect(snap.local['near_miss_data']).toBe(nearMiss1);
    expect(snap.session['fake_key']).toBe(nearMiss2);
  });
});

/**
 * A throwing observation must never escape into the app.
 *
 * The patched `setItem` builds its payload INSIDE the app's call stack — reading the old value,
 * resolving the area, redacting. Guarding only the transport hop left all of that exposed, so a throw
 * there surfaced as an exception from `localStorage.setItem` AFTER the write had already succeeded.
 * The app sees a failure that did not happen, caused entirely by the observability SDK.
 */
describe('a failing observation cannot break the host app', () => {
  it('setItem still succeeds and still writes when emit throws', () => {
    const teardown = installStorage(() => {
      throw new Error('observer blew up');
    });
    try {
      expect(() => localStorage.setItem('k', 'v')).not.toThrow();
      expect(localStorage.getItem('k')).toBe('v');
    } finally {
      teardown();
      localStorage.removeItem('k');
    }
  });

  it('removeItem still succeeds and still removes when emit throws', () => {
    localStorage.setItem('gone', 'x');
    const teardown = installStorage(() => {
      throw new Error('observer blew up');
    });
    try {
      expect(() => localStorage.removeItem('gone')).not.toThrow();
      expect(localStorage.getItem('gone')).toBeNull();
    } finally {
      teardown();
    }
  });
});
