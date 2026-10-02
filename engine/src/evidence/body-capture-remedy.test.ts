/**
 * A remedy that cannot be followed is worse than no remedy.
 *
 * Six verdicts came back `unknown`/`outcome_unread`, each advising
 * `reticle.connect({ captureNetworkBodies: true })`. That repo pinned an `@reticlehq/react` from
 * before the setting existed, so neither the option nor its env var was there. The reporter set the
 * env var, restarted, got the identical message, and worked it out by elimination.
 *
 * We already know enough to say the true thing: the daemon is told the page's SDK version at HELLO.
 * It just threw it away after computing skew.
 *
 * Same class as #618, where the version-skew remedy named a React package on Vue projects — remedy
 * text that does not check whether it applies.
 */

import { describe, expect, it } from 'vitest';
import { bodyCaptureRemedy, BODY_CAPTURE_MIN_VERSION } from './body-capture-remedy.js';

describe('the body-capture remedy checks whether it applies', () => {
  it('does NOT name the setting when the SDK predates it', () => {
    const message = bodyCaptureRemedy('2.1.0');
    expect(message).toContain('2.1.0');
    expect(message).toContain(BODY_CAPTURE_MIN_VERSION);
    expect(
      message,
      'printing an option that does not exist is what cost the reporter the session',
    ).not.toContain('captureNetworkBodies');
  });

  it('names the setting when the SDK supports it', () => {
    const message = bodyCaptureRemedy('2.13.1');
    expect(message).toContain('captureNetworkBodies');
  });

  it('treats an unknown version as capable, rather than withholding a working fix', () => {
    // A hand-wired connect reports no version. Guessing "too old" there would hide the remedy from
    // someone who could have used it — and the failure mode of the other guess is one wasted read.
    const message = bodyCaptureRemedy(undefined);
    expect(message).toContain('captureNetworkBodies');
  });

  it('compares versions numerically, not as strings', () => {
    // '2.10.0' < '2.4.0' lexically, which would tell a NEWER SDK it is too old — the exact inversion
    // that makes a version check worse than none.
    expect(bodyCaptureRemedy('2.10.0')).toContain('captureNetworkBodies');
    expect(bodyCaptureRemedy('2.3.9')).not.toContain('captureNetworkBodies');
  });

  it('handles a prerelease tag without deciding it is ancient', () => {
    expect(bodyCaptureRemedy('2.13.0-rc.1')).toContain('captureNetworkBodies');
  });
});
