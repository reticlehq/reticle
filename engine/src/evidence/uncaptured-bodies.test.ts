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
