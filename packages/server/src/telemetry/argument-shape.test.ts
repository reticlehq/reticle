import { describe, expect, it } from 'vitest';
import {
  OTHER_VALUE,
  describeCliFlags,
  describeParam,
  describeToolParams,
} from './argument-shape.js';
import { SessionMetrics } from './session-metrics.js';

/**
 * This is the highest-risk data Reticle collects, so every test here is a leak that must not happen.
 * The rule under test is NAMES yes, VALUES no — with one narrow, explicitly listed exception for
 * parameters whose values are enums we wrote ourselves.
 */
describe('CLI flags — names only, never values', () => {
  it('reports which flags were present', () => {
    expect(describeCliFlags(['serve', '--headed', '--port', '9000'])).toEqual([
      '--headed',
      '--port',
    ]);
  });

  it('NEVER reports a flag value, even for a secret-bearing flag', () => {
    const flags = describeCliFlags(['serve', '--http-token', 's3cr3t-pairing-token']);
    expect(flags).toEqual(['--http-token']);
    expect(flags.join()).not.toContain('s3cr3t');
  });

  it('splits `--flag=value` so the value is dropped with everything else', () => {
    expect(describeCliFlags(['serve', '--port=9000'])).toEqual(['--port']);
  });

  it.each([
    ['a URL', ['drive', 'https://acme.internal/checkout']],
    ['a file path', ['verify', '/Users/ada/secret-app/state.json']],
    ['a feedback message', ['feedback', 'your tool broke on our billing page']],
  ])("drops %s entirely — positional arguments are the user's, not ours", (_label, argv) => {
    expect(describeCliFlags(argv)).toEqual([]);
  });

  it('deduplicates and sorts, so the property is stable across invocations', () => {
    expect(describeCliFlags(['a', '--b', '--a', '--b'])).toEqual(['--a', '--b']);
  });
});

describe('tool parameters — names, plus only our own enums', () => {
  it('reports which parameters an agent passed, minus the ones every call carries', () => {
    // sessionId is dropped: nearly every tool takes it and nearly every call passes it, so counting
    // it filled a third of the histogram with "the agent addressed a session". See event-hygiene.
    expect(describeToolParams({ ref: 'e7', sessionId: 'abc' })).toEqual(['ref']);
  });

  /**
   * The one that matters most. `reticle_act`'s `args` carries the text being typed into the app,
   * which on a login form is a password.
   */
  it('NEVER reports the text being typed into the app', () => {
    const described = describeToolParams({ ref: 'e7', action: 'type', args: 'hunter2' });
    expect(described.join()).not.toContain('hunter2');
    expect(described).toContain('args');
  });

  it('NEVER reports values passed to seedStorage in telemetry', () => {
    const described = describeToolParams({
      url: 'http://localhost:3000',
      seedStorage: {
        local: { token: 'super-secret-jwt' },
        session: { auth: 'session-secret' },
        cookies: { id: 'cookie-secret' },
      },
    });
    expect(described).toEqual(['seedStorage', 'url']);
    expect(described.join()).not.toContain('super-secret-jwt');
    expect(described.join()).not.toContain('session-secret');
    expect(described.join()).not.toContain('cookie-secret');
  });

  it('reports a value only for an allowlisted enum parameter', () => {
    expect(describeParam('action', 'click')).toBe('action:click');
    // `ref` is a selector the user's DOM defines — a name, never a value.
    expect(describeParam('ref', 'e7')).toBe('ref');
  });

  /**
   * The fallback that keeps the allowlist safe against its own future: if one of these parameters
   * ever starts accepting free text, unknown values report as `other` instead of forwarding it.
   */
  it('reports an unrecognized value as `other` rather than forwarding it', () => {
    expect(describeParam('action', 'some-new-freeform-thing')).toBe(`action:${OTHER_VALUE}`);
    expect(describeParam('action', 'a-customer-email@acme.com')).not.toContain('acme');
  });

  it('does not report a non-string value even for an allowlisted name', () => {
    expect(describeParam('mode', { nested: 'object' })).toBe('mode');
  });

  it('omits parameters that were not actually passed', () => {
    expect(describeToolParams({ ref: 'e7', sessionId: undefined })).toEqual(['ref']);
  });
});

describe('parameter usage in the session summary', () => {
  it('counts parameter usage per tool, so "does anyone pass fullPage?" is answerable', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act', { ref: 'e1', action: 'click' });
    m.recordToolCall('reticle_act', { ref: 'e2', action: 'click' });
    m.recordToolCall('reticle_act', { ref: 'e3', action: 'type', args: 'hunter2' });
    m.recordToolCall('reticle_screenshot', { name: 'home', fullPage: true });
    const params = m.summarize(true).toolParams ?? {};
    expect(params['reticle_act']).toEqual({ ref: 3, 'action:click': 2, 'action:type': 1, args: 1 });
    expect(params['reticle_screenshot']).toEqual({ name: 1, fullPage: 1 });
    // No value from any non-enum parameter reached the summary.
    expect(JSON.stringify(params)).not.toContain('hunter2');
    expect(JSON.stringify(params)).not.toContain('home');
  });

  it('records a call with no args without inventing a parameter map', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_sessions');
    expect(m.summarize(true).toolParams).toBeUndefined();
    expect(m.summarize(true).toolCalls).toBe(1);
  });
});
