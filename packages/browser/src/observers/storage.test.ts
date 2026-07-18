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

  it('scopes to a single area', () => {
    localStorage.setItem('k', 'v');
    expect(readStorage('local')).toEqual({ k: 'v' });
  });
});
