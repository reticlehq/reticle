/**
 * Alternate loopback URLs for a readiness probe that missed on the announced host (#884).
 */

import { describe, expect, it } from 'vitest';
import { loopbackProbeUrls } from './loopback-probe-urls.js';

describe('loopbackProbeUrls', () => {
  it('keeps a non-loopback URL as a single candidate', () => {
    expect(loopbackProbeUrls('https://app.example:443/path')).toEqual([
      'https://app.example:443/path',
    ]);
  });

  it('tries IPv4, localhost, and IPv6 when the announcement is IPv4-only', () => {
    expect(loopbackProbeUrls('http://127.0.0.1:5173/')).toEqual([
      'http://127.0.0.1:5173/',
      'http://localhost:5173/',
      'http://[::1]:5173/',
    ]);
  });

  it("keeps the caller's host first when it announced localhost", () => {
    expect(loopbackProbeUrls('http://localhost:3000')).toEqual([
      'http://localhost:3000/',
      'http://127.0.0.1:3000/',
      'http://[::1]:3000/',
    ]);
  });

  it('returns a bad URL unchanged rather than throwing', () => {
    expect(loopbackProbeUrls('not a url')).toEqual(['not a url']);
  });
});
