import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { MCP_PROXY_HTTP_AGENT_OPTIONS, postToSession, shouldRetryUnsentPost } from './mcp-proxy.js';
import { daemonPollDelayMs } from './proxy-daemon-probe.js';

const noBuffers = Object.assign(new Error('no buffer space'), { code: 'ENOBUFS' });

describe('MCP POST transport', () => {
  it('keeps POST requests on a bounded, long-lived socket pool', () => {
    expect(MCP_PROXY_HTTP_AGENT_OPTIONS).toEqual({
      keepAlive: true,
      keepAliveMsecs: 30_000,
      timeout: 60_000,
      maxSockets: 8,
      scheduling: 'lifo',
    });
  });

  it('only retries transient socket exhaustion before this request wrote bytes', () => {
    expect(shouldRetryUnsentPost(noBuffers, 0, 0)).toBe(true);
    expect(
      shouldRetryUnsentPost(
        Object.assign(new Error('no buffer space'), { code: 'ERR_NO_BUFFER_SPACE' }),
        0,
        0,
      ),
    ).toBe(true);
    expect(
      shouldRetryUnsentPost(
        Object.assign(new Error('address unavailable'), { code: 'EADDRNOTAVAIL' }),
        0,
        0,
      ),
    ).toBe(true);
    expect(shouldRetryUnsentPost(noBuffers, 1, 0)).toBe(false);
    expect(shouldRetryUnsentPost(noBuffers, 0, 1)).toBe(false);
    expect(
      shouldRetryUnsentPost(Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 0, 0),
    ).toBe(false);
  });

  it('retries one unsent ENOBUFS request and then succeeds', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = ((_options, callback) => {
      attempts++;
      const req = new EventEmitter() as http.ClientRequest;
      req.end = (() => {
        if (1 === attempts) {
          queueMicrotask(() => req.emit('error', noBuffers));
        } else {
          const response = new EventEmitter() as http.IncomingMessage;
          response.statusCode = 202;
          response.resume = vi.fn().mockReturnValue(response);
          queueMicrotask(() => callback(response));
        }
        return req;
      }) as http.ClientRequest['end'];
      return req;
    }) satisfies Parameters<typeof postToSession>[2];

    const result = postToSession('http://127.0.0.1:4400/session', '{}', request);
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toBeNull();
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it('does not retry after any request bytes were written', () => {
    expect(shouldRetryUnsentPost(noBuffers, 24, 0)).toBe(false);
  });
});

describe('daemon readiness polling', () => {
  it('backs off failed probes and caps the interval', () => {
    expect(daemonPollDelayMs(1)).toBe(100);
    expect(daemonPollDelayMs(5)).toBe(500);
    expect(daemonPollDelayMs(50)).toBe(1_000);
  });
});
