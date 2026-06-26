import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isLoopbackPeer, requestToken, tokensMatch } from './token-auth.js';

function reqWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('tokensMatch', () => {
  it('matches an exact token', () => {
    expect(tokensMatch('s3cret', 's3cret')).toBe(true);
  });

  it('rejects a wrong token, a length mismatch, and undefined (no timingSafeEqual throw)', () => {
    expect(tokensMatch('s3cret', 'wrong!')).toBe(false);
    expect(tokensMatch('s3cret', 's3cre')).toBe(false);
    expect(tokensMatch('s3cret', undefined)).toBe(false);
  });
});

describe('requestToken', () => {
  it('reads the bearer header first', () => {
    expect(
      requestToken(reqWith({ authorization: 'Bearer abc' }), new URL('http://x/mcp/sse')),
    ).toBe('abc');
  });

  it('falls back to the ?token= query param', () => {
    expect(requestToken(reqWith({}), new URL('http://x/mcp/sse?token=xyz'))).toBe('xyz');
  });

  it('is undefined when neither is present', () => {
    expect(requestToken(reqWith({}), new URL('http://x/mcp/sse'))).toBeUndefined();
  });
});

describe('isLoopbackPeer', () => {
  it('accepts IPv4, IPv6, and IPv4-mapped loopback', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects a remote address and undefined', () => {
    expect(isLoopbackPeer('10.0.0.5')).toBe(false);
    expect(isLoopbackPeer('203.0.113.7')).toBe(false);
    expect(isLoopbackPeer(undefined)).toBe(false);
  });
});
