import { describe, expect, it } from 'vitest';
import { RECOVERY, buildErrorPayload, recoveryFor } from './error-recovery.js';

describe('recoveryFor — every known error carries an actionable next move', () => {
  it('maps the no-session footgun to a concrete recovery', () => {
    const hint = recoveryFor(
      'no browser session connected — is your app running with @syrin/iris-browser enabled?',
    );
    expect(hint).toBe(RECOVERY.NO_SESSION);
    expect(hint).toMatch(/iris status/);
  });

  it('maps multiple-sessions to "pass a sessionId from iris_sessions"', () => {
    expect(recoveryFor('multiple sessions connected — pass sessionId to target one: a, b')).toBe(
      RECOVERY.MULTIPLE_SESSIONS,
    );
  });

  it('maps an unknown sessionId to "list ids and retry"', () => {
    expect(recoveryFor("no connected session with id 'ghost'")).toBe(RECOVERY.UNKNOWN_SESSION);
  });

  it('maps a throttled-tab refusal to the refocus / iris drive escape hatch', () => {
    expect(
      recoveryFor(
        'refusing to act: tab throttled; timer/rAF/pointer gestures may silently no-op — refocus before driving',
      ),
    ).toBe(RECOVERY.THROTTLED);
  });

  it('maps a missing baseline / recording to the create-it-first hint', () => {
    expect(recoveryFor('no baseline named "home"')).toBe(RECOVERY.MISSING_BASELINE);
    expect(recoveryFor('no active recording named "ship"')).toBe(RECOVERY.MISSING_RECORDING);
    expect(recoveryFor('no compiled recording named "ship"')).toBe(RECOVERY.MISSING_RECORDING);
  });

  it('maps the pairing-token error to its config fix', () => {
    expect(
      recoveryFor('a pairing token is required when the Iris bridge binds beyond localhost'),
    ).toBe(RECOVERY.TOKEN_REQUIRED);
  });

  it('returns undefined for an unrecognized error (never invents a hint)', () => {
    expect(recoveryFor('save failed: disk_full')).toBeUndefined();
    expect(recoveryFor('')).toBeUndefined();
  });
});

describe('buildErrorPayload — the MCP-boundary envelope', () => {
  it('adds recovery only when the error is recognized', () => {
    const known = buildErrorPayload('no browser session connected — is your app running?');
    expect(known).toEqual({
      error: 'no browser session connected — is your app running?',
      recovery: RECOVERY.NO_SESSION,
    });
    const unknown = buildErrorPayload('save failed: disk_full');
    expect(unknown).toEqual({ error: 'save failed: disk_full' });
    expect('recovery' in unknown).toBe(false);
  });
});
