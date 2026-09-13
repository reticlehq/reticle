import { describe, expect, it } from 'vitest';
import { fingerprintFinding } from './finding-fingerprint.js';

describe('fingerprintFinding', () => {
  it('produces the same hash for the same inputs (stability)', () => {
    const a = fingerprintFinding({
      kind: 'signal-contradicted',
      source: 'contradiction',
      route: '/dashboard',
    });
    const b = fingerprintFinding({
      kind: 'signal-contradicted',
      source: 'contradiction',
      route: '/dashboard',
    });
    expect(a).toBe(b);
  });

  it('produces a different hash when the kind changes', () => {
    const a = fingerprintFinding({
      kind: 'signal-contradicted',
      source: 'contradiction',
      route: '/',
    });
    const b = fingerprintFinding({ kind: 'response-ignored', source: 'contradiction', route: '/' });
    expect(a).not.toBe(b);
  });

  it('produces a different hash when the route changes', () => {
    const a = fingerprintFinding({
      kind: 'signal-contradicted',
      source: 'contradiction',
      route: '/a',
    });
    const b = fingerprintFinding({
      kind: 'signal-contradicted',
      source: 'contradiction',
      route: '/b',
    });
    expect(a).not.toBe(b);
  });

  it('produces a different hash when the source changes', () => {
    const a = fingerprintFinding({ kind: 'console-error', source: 'crawl', route: '/' });
    const b = fingerprintFinding({ kind: 'console-error', source: 'assertion', route: '/' });
    expect(a).not.toBe(b);
  });

  it('treats absent route as a distinct identity from any present route', () => {
    const noRoute = fingerprintFinding({ kind: 'signal-contradicted', source: 'contradiction' });
    const rootRoute = fingerprintFinding({
      kind: 'signal-contradicted',
      source: 'contradiction',
      route: '/',
    });
    expect(noRoute).not.toBe(rootRoute);
  });

  it('returns an 8-character hex string', () => {
    const fp = fingerprintFinding({ kind: 'dead-control', source: 'crawl' });
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });
});
