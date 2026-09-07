/**
 * The body-capture remedy must check whether THIS session's SDK can follow it.
 *
 * Three field reports, one failure: the daemon printed `reticle.connect({ captureNetworkBodies: true })`
 * (and the Vite env var) against an SDK that had neither, against a session where capture was already
 * on, and only after the caller had spent the action to find out. The three states — unsupported
 * version, supported-but-off, on — have to produce three distinct messages, and the unsupported one
 * must never name the setting.
 */
import { describe, expect, it } from 'vitest';
import {
  BODY_CAPTURE_SINCE,
  bodyCaptureRemedy,
  sdkSupportsBodyCapture,
} from './body-capture-remedy.js';

const SETTING = 'captureNetworkBodies';
const ENV = 'VITE_RETICLE_CAPTURE_BODIES';

describe('sdkSupportsBodyCapture', () => {
  it('is true from the first release that shipped the connect() option', () => {
    expect(sdkSupportsBodyCapture(BODY_CAPTURE_SINCE)).toBe(true);
    expect(sdkSupportsBodyCapture('2.13.1')).toBe(true);
  });

  it('is false for a version that predates the setting, and for an unknown version', () => {
    expect(sdkSupportsBodyCapture('2.0.1')).toBe(false);
    expect(sdkSupportsBodyCapture(undefined)).toBe(false);
  });
});

describe('bodyCaptureRemedy — three states, three messages', () => {
  it('unsupported version names both versions and never names the setting', () => {
    const text = bodyCaptureRemedy({ sdkVersion: '2.0.1', bodiesMissing: true });
    expect(text).toBeDefined();
    expect(text).toContain('2.0.1');
    expect(text).toContain(BODY_CAPTURE_SINCE);
    expect(text).not.toContain(SETTING);
    expect(text).not.toContain(ENV);
  });

  it('supported-but-off names the connect() option and the runtime env var', () => {
    const text = bodyCaptureRemedy({
      sdkVersion: '2.13.1',
      captureNetworkBodies: false,
    });
    expect(text).toBeDefined();
    expect(text).toContain('reticle.connect({ captureNetworkBodies: true })');
    expect(text).toContain(ENV);
    expect(text).not.toContain('2.13.1');
  });

  it('on is silent — capture is already producing bodies, so the setting is not a remedy', () => {
    expect(bodyCaptureRemedy({ sdkVersion: '2.13.1', captureNetworkBodies: true })).toBeUndefined();
  });

  it('an unknown version with missing bodies does not guess the setting exists', () => {
    const text = bodyCaptureRemedy({ bodiesMissing: true });
    expect(text).toBeDefined();
    expect(text).toContain('unknown');
    expect(text).toContain(BODY_CAPTURE_SINCE);
    expect(text).not.toContain(SETTING);
    expect(text).not.toContain(ENV);
  });

  it('a modern SDK that never announced the flag is not refused until bodies are missing', () => {
    // 2.1.0 through the release before HELLO grew the flag: they SUPPORT the setting but do not
    // send it. Refusing a bodyContains clause here would break every current session.
    expect(bodyCaptureRemedy({ sdkVersion: '2.13.1' })).toBeUndefined();
  });

  it('a known-old SDK is refused even before any body is missing', () => {
    const text = bodyCaptureRemedy({ sdkVersion: '2.0.1' });
    expect(text).toContain('2.0.1');
    expect(text).not.toContain(SETTING);
  });

  it('announcing the flag off is enough to name the setting, even without a version stamp', () => {
    // The field existing on HELLO is the proof this SDK has the option. A hand-wired connect that
    // omitted sdkVersion must still be told how to turn capture on.
    const text = bodyCaptureRemedy({ captureNetworkBodies: false });
    expect(text).toContain(SETTING);
  });
});
