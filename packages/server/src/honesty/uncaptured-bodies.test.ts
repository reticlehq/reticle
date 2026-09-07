import { describe, it, expect } from 'vitest';
import { bodiesNotCaptured } from './uncaptured-bodies.js';

/**
 * #394: the "bodies are not being recorded" note fired on a result that plainly recorded a body.
 * `bodiesNotCaptured` decided purely on request bodies across body-bearing methods, so a call whose
 * request body was not stringified (a multipart upload, an SDK-skipped body) tripped the warning
 * even when a response body in the same result proved capture was on. A present response body is
 * evidence that recording is enabled.
 */
describe('bodiesNotCaptured', () => {
  it('fires when a body-bearing call carried no body at all', () => {
    const out = bodiesNotCaptured([{ method: 'POST', url: '/api/pay' } as never]);
    expect(out.bodiesNotCaptured).toContain('NOT being recorded');
  });

  it('stays silent when a response body was recorded, even if the request body was not (#394)', () => {
    // A multipart upload the SDK did not stringify: no requestBody, but the response was captured.
    // The old logic looked only at requestBody and cried "not recording" over a visible body.
    const out = bodiesNotCaptured([
      { method: 'POST', url: '/api/upload', responseBody: '{"id":9}' } as never,
    ]);
    expect(out.bodiesNotCaptured).toBeUndefined();
  });

  it('stays silent when a request body is present (unchanged)', () => {
    const out = bodiesNotCaptured([
      { method: 'POST', url: '/api/todos', requestBody: '{"title":"x"}' } as never,
    ]);
    expect(out.bodiesNotCaptured).toBeUndefined();
  });

  it('says nothing when there are no body-bearing calls', () => {
    const out = bodiesNotCaptured([{ method: 'GET', url: '/api/todos' } as never]);
    expect(out.bodiesNotCaptured).toBeUndefined();
  });
});

describe('bodiesNotCaptured — the remedy matches the SDK', () => {
  const post = [{ method: 'POST', url: '/api/pay' }];

  it('names both versions and never the setting when the SDK predates body capture', () => {
    const out = bodiesNotCaptured(post, { sdkVersion: '2.0.1' });
    expect(out.bodiesNotCaptured).toContain('2.0.1');
    expect(out.bodiesNotCaptured).toContain('2.1.0');
    expect(out.bodiesNotCaptured).not.toContain('captureNetworkBodies');
    expect(out.bodiesNotCaptured).not.toContain('VITE_RETICLE_CAPTURE_BODIES');
  });

  it('names connect() and the env var when the SDK supports capture and it is off', () => {
    const out = bodiesNotCaptured(post, {
      sdkVersion: '2.13.1',
      captureNetworkBodies: false,
    });
    expect(out.bodiesNotCaptured).toContain('reticle.connect({ captureNetworkBodies: true })');
    expect(out.bodiesNotCaptured).toContain('VITE_RETICLE_CAPTURE_BODIES=1');
  });

  it('stays silent when HELLO said capture is on, even if this call carried no body', () => {
    const out = bodiesNotCaptured(post, {
      sdkVersion: '2.13.1',
      captureNetworkBodies: true,
    });
    expect(out.bodiesNotCaptured).toBeUndefined();
  });
});
