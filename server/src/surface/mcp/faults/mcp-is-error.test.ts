/**
 * `isError` was not a pass/fail discriminator, and half the surface relies on that.
 *
 * Only a THROWN failure set it. Every tool that RETURNS a well-formed `{ error, recovery }` object —
 * the flow tools, annotate, project, run_export, both visual tools, viewport, network_mock,
 * navigate's missing url, and feedback itself — came back as protocol SUCCESS with `isError` unset.
 * An agent (or a harness) branching on `isError`, which is what the field it is named after is for,
 * reads every one of those as having worked.
 *
 * Reported from a field sweep that had to special-case the shape of each result to score a run at
 * all. The convention already exists — a top-level `error` string is how this codebase says a tool
 * refused — so the flag simply has to follow it.
 */

import { describe, expect, it } from 'vitest';
import { resultIsError } from './mcp-is-error.js';

describe('resultIsError', () => {
  it('is true for the refusal shape the tools actually return', () => {
    expect(
      resultIsError({ error: 'no browser session connected', recovery: 'start your app' }),
    ).toBe(true);
  });

  it('is false for a normal result', () => {
    expect(resultIsError({ entries: [], window_ms: 2000 })).toBe(false);
  });

  it('is false when `error` is not a top-level refusal', () => {
    // A console entry whose LEVEL is error, or a network row carrying an error body, is data.
    expect(resultIsError({ entries: [{ level: 'error', text: 'boom' }] })).toBe(false);
    expect(resultIsError({ requests: [{ url: '/x', error: 'ECONNREFUSED' }] })).toBe(false);
  });

  it('is false for an empty error string, which says nothing and should not flip a flag', () => {
    expect(resultIsError({ error: '' })).toBe(false);
  });

  it('is false for a non-object result', () => {
    expect(resultIsError('some text')).toBe(false);
    expect(resultIsError([{ error: 'x' }])).toBe(false);
    expect(resultIsError(undefined)).toBe(false);
  });
});
