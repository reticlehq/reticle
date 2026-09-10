import { describe, expect, it } from 'vitest';
import { reconcileStack } from './feedback-context.js';

/**
 * Feedback must be stamped with the project it came FROM, not with whatever directory the daemon
 * happens to have been started in.
 *
 * Reported from the field: a report filed from an astro session arrived stamped
 * `"stack":"sveltekit"`. One daemon was serving several fixtures, `detectStack` read its cwd, and
 * the sessionId the caller passed was ignored for attribution entirely. Every report from a
 * multi-app machine is filed against the wrong framework, which is worse than filing none: it is
 * evidence pointing at an innocent stack.
 */
describe('reconcileStack — the app outranks the directory when they disagree', () => {
  it('keeps the more specific meta-framework when the app agrees with it', () => {
    // react + next are the same app described at two levels; next is the useful answer.
    expect(reconcileStack({ stack: 'next', stackMajor: 15 }, ['react'])).toEqual({
      stack: 'next',
      stackMajor: 15,
    });
    expect(reconcileStack({ stack: 'sveltekit', stackMajor: 2 }, ['svelte'])).toEqual({
      stack: 'sveltekit',
      stackMajor: 2,
    });
    expect(reconcileStack({ stack: 'tanstack-start', stackMajor: 1 }, ['react'])).toEqual({
      stack: 'tanstack-start',
      stackMajor: 1,
    });
  });

  it('takes the APP when the directory describes a different family — the reported bug', () => {
    expect(reconcileStack({ stack: 'sveltekit', stackMajor: 2 }, ['react'])).toEqual({
      stack: 'react',
    });
  });

  it('drops the major with the stack it belonged to', () => {
    // A version read off sveltekit's package.json says nothing about a React app.
    expect(
      reconcileStack({ stack: 'sveltekit', stackMajor: 2 }, ['react']).stackMajor,
    ).toBeUndefined();
  });

  it('falls back to the directory when the app reports nothing usable', () => {
    for (const adapters of [undefined, [], ['something-unknown']]) {
      expect(reconcileStack({ stack: 'astro' }, adapters)).toEqual({ stack: 'astro' });
    }
  });

  it('uses the app even when the directory yielded no stack at all', () => {
    expect(reconcileStack({}, ['vue'])).toEqual({ stack: 'vue' });
  });
});
