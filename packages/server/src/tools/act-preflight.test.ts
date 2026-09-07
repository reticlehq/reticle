/**
 * `bodyContains` against a session that cannot produce bodies must not spend the click.
 */
import { describe, expect, it } from 'vitest';
import { preflightAct } from './act-preflight.js';

const click = { ref: 'e1', action: 'click' };
const until = { kind: 'net', urlContains: '/api/refund', bodyContains: '1187.01' };

describe('preflightAct — body capture', () => {
  it('refuses a supported-but-off session before dispatch', () => {
    expect(() =>
      preflightAct(click, until, { sdkVersion: '2.13.1', captureNetworkBodies: false }),
    ).toThrow(/Nothing was acted on/);
    expect(() =>
      preflightAct(click, until, { sdkVersion: '2.13.1', captureNetworkBodies: false }),
    ).toThrow(/captureNetworkBodies/);
  });

  it('refuses a known-old SDK without naming the setting', () => {
    expect(() => preflightAct(click, until, { sdkVersion: '2.0.1' })).toThrow(/2\.0\.1/);
    expect(() => preflightAct(click, until, { sdkVersion: '2.0.1' })).not.toThrow(
      /captureNetworkBodies/,
    );
  });

  it('lets a modern SDK that has not announced the flag through — missing bodies decide later', () => {
    expect(() => preflightAct(click, until, { sdkVersion: '2.13.1' })).not.toThrow();
  });
});
