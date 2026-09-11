/**
 * `annotate_no_step` against a recording that HAS steps.
 *
 * Reproduced on three apps in a field sweep, and then here:
 *
 *   reticle_record { action: "start", recordingName: "my-flow" }   <- the only recording running
 *   reticle_act    { ... }                                          -> captured into "my-flow"
 *   reticle_annotate { kind: "assert-visible", testid: "x" }        -> annotate_no_step
 *   reticle_annotate { flow: "my-flow", ... }                       -> ok
 *
 * `annotate` defaulted to the literal name `default` instead of the recording that is actually
 * running. With exactly one in progress there is no ambiguity to resolve, and choosing a different
 * recording is indefensible — the agent gets told its recording has no steps when the steps are
 * sitting in the one it started.
 *
 * The error was silent about it too: `annotate_no_step` with no mention that another recording
 * exists, so the agent's next move is to record MORE steps into the wrong place.
 */

import { describe, expect, it } from 'vitest';
import { resolveAnnotateTarget } from './annotate-target.js';

const DEFAULT = 'default';

describe('which recording an annotation lands in', () => {
  it('uses an explicit name, always', () => {
    expect(resolveAnnotateTarget('my-flow', ['other'])).toBe('my-flow');
  });

  it('uses the ONLY active recording when no name is given', () => {
    // The reported case. One recording running, so there is nothing to disambiguate.
    expect(resolveAnnotateTarget(undefined, ['my-flow'])).toBe('my-flow');
  });

  it('falls back to `default` when nothing is recording', () => {
    // Preserves the existing "no recording" error rather than inventing a target.
    expect(resolveAnnotateTarget(undefined, [])).toBe(DEFAULT);
  });

  it('prefers `default` when SEVERAL are running and one of them is it', () => {
    // Ambiguity is real here, and `default` is the documented answer — picking another silently
    // would put the assertion in a flow the agent never named.
    expect(resolveAnnotateTarget(undefined, ['default', 'my-flow'])).toBe(DEFAULT);
  });

  it('refuses to guess between several named recordings', () => {
    // No `default` among them and more than one candidate: any pick is a coin flip, so it keeps the
    // documented default and the caller gets an error naming what IS active.
    expect(resolveAnnotateTarget(undefined, ['a', 'b'])).toBe(DEFAULT);
  });
});
