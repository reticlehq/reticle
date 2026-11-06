/**
 * A lease on a loopback page with a strict CSP never connected (#2163): the widening ran only off
 * loopback. It now runs on loopback when a probe of the page finds a CSP that blocks the daemon,
 * and a loopback page with no such CSP gets no route at all.
 */
import { describe, expect, it } from 'vitest';
import { widenLeaseCsp } from './context-permissions.js';
import type { CspProbeFetch } from './context-permissions.js';
import type { PooledContext } from './pool-contract.js';

const DAEMON = 'ws://127.0.0.1:4400';

function contextRecording(origins: string[]): PooledContext {
  return {
    widenCsp: (origin: string, onWidened: () => void) => {
      origins.push(origin);
      onWidened();
      return Promise.resolve();
    },
  } as unknown as PooledContext;
}

function serving(headers: Record<string, string>, body = ''): CspProbeFetch {
  return () =>
    Promise.resolve({ headers: new Headers(headers), text: () => Promise.resolve(body) });
}

describe('widenLeaseCsp on a loopback page', () => {
  it("widens when connect-src 'self' would block the daemon, and says so", async () => {
    const origins: string[] = [];
    const result = await widenLeaseCsp(
      contextRecording(origins),
      'http://127.0.0.1:3194/',
      DAEMON,
      serving({ 'content-security-policy': "default-src 'self'; connect-src 'self'" }),
    );
    expect(origins).toEqual([DAEMON]);
    expect(result.widenedFor).toBe(DAEMON);
  });

  it('widens when the CSP is a meta tag', async () => {
    const origins: string[] = [];
    await widenLeaseCsp(
      contextRecording(origins),
      'http://localhost:3194/',
      DAEMON,
      serving(
        { 'content-type': 'text/html' },
        `<meta http-equiv="Content-Security-Policy" content="connect-src 'self'">`,
      ),
    );
    expect(origins).toEqual([DAEMON]);
  });

  it('installs no route for a page with no CSP', async () => {
    const origins: string[] = [];
    const result = await widenLeaseCsp(
      contextRecording(origins),
      'http://127.0.0.1:5173/',
      DAEMON,
      serving({ 'content-type': 'text/html' }, '<html></html>'),
    );
    expect(origins).toEqual([]);
    expect(result.widenedFor).toBeUndefined();
  });

  it('installs no route when the CSP already allows the daemon', async () => {
    const origins: string[] = [];
    await widenLeaseCsp(
      contextRecording(origins),
      'http://127.0.0.1:5173/',
      DAEMON,
      serving({ 'content-security-policy': `connect-src 'self' ${DAEMON}` }),
    );
    expect(origins).toEqual([]);
  });

  it('installs no route when the page cannot be probed', async () => {
    const origins: string[] = [];
    await widenLeaseCsp(contextRecording(origins), 'http://127.0.0.1:5173/', DAEMON, () =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    expect(origins).toEqual([]);
  });
});
