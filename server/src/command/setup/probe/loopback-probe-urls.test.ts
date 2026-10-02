/**
 * Alternate loopback URLs for a readiness probe that missed on the announced host (#884).
 */

import { describe, expect, it } from 'vitest';
import { isAddressMiss, loopbackProbeUrls } from './loopback-probe-urls.js';

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

/**
 * Only a refusal is a family miss. A cold Next 16 first compile took sixteen seconds on `localhost`;
 * reading that timeout as "wrong family" walked on to `127.0.0.1`, which answered, became the app
 * url, and is an origin Next blocks its dev resources for, so the SDK never ran.
 */
describe('isAddressMiss', () => {
  const fetchFailed = (cause: unknown): Error =>
    Object.assign(new TypeError('fetch failed'), { cause });

  it('counts a refused connection as a miss on this address', () => {
    expect(isAddressMiss(fetchFailed({ code: 'ECONNREFUSED' }))).toBe(true);
    expect(isAddressMiss(fetchFailed({ code: 'EADDRNOTAVAIL' }))).toBe(true);
    expect(isAddressMiss(fetchFailed({ code: 'ENOTFOUND' }))).toBe(true);
  });

  it('counts every address of a happy-eyeballs attempt refusing as a miss', () => {
    const aggregate = Object.assign(new AggregateError([]), {
      errors: [{ code: 'ECONNREFUSED' }, { code: 'EADDRNOTAVAIL' }],
    });
    expect(isAddressMiss(fetchFailed(aggregate))).toBe(true);
  });

  it('never counts a timeout as a miss: a slow server is still the right server', () => {
    expect(
      isAddressMiss(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    ).toBe(false);
    expect(isAddressMiss(new DOMException('aborted', 'AbortError'))).toBe(false);
  });

  it('never counts a server that answered and then failed as a miss', () => {
    expect(isAddressMiss(fetchFailed({ code: 'ECONNRESET' }))).toBe(false);
    expect(isAddressMiss(fetchFailed({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toBe(false);
    expect(isAddressMiss(new Error('something else'))).toBe(false);
  });
});
