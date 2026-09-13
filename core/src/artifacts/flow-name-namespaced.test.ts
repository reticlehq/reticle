import { describe, expect, it } from 'vitest';
import { FLOW_NAME_PATTERN } from './flow-constants.js';

/**
 * A flow name may be NAMESPACED, because the replay grammar addresses documents by path.
 *
 * `onboarding/signup` is how a composite names the sub-journey it invokes — the protocol's
 * `FlowNameSchema` has said so since grammar v2. This pattern is the persistence half and it said
 * single-segment-only, so `reticle_flow_save` refused every name the language is built on. Found by
 * driving: recording a composite worked, closing the boundary worked, and saving it was refused.
 *
 * Traversal is impossible by CONSTRUCTION rather than by a check: no segment may contain a dot at
 * all, so `..` cannot be spelled, and every segment must begin with a letter or digit, so a leading
 * or doubled separator cannot either. That is a stronger guarantee than filtering for `..` — there
 * is no encoding of it left to miss.
 */

const ok = (name: string) => FLOW_NAME_PATTERN.test(name);

describe('a flow name', () => {
  it('accepts a single segment, as it always has', () => {
    expect(ok('checkout')).toBe(true);
    expect(ok('sign-in_2')).toBe(true);
  });

  it('accepts a namespaced path', () => {
    expect(ok('onboarding/signup')).toBe(true);
    expect(ok('onboarding/signup/email')).toBe(true);
  });

  it('refuses anything that could leave the flows directory', () => {
    for (const bad of [
      '../escape',
      'a/../b',
      './here',
      'a/./b',
      '/leading',
      'trailing/',
      'a//b',
      '',
    ]) {
      expect(ok(bad), `"${bad}" must not be a flow name`).toBe(false);
    }
  });

  it('refuses a dot anywhere, so no traversal can be spelled at all', () => {
    expect(ok('a.b')).toBe(false);
    expect(ok('a/b.json')).toBe(false);
  });
});
