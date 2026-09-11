import { describe, expect, it } from 'vitest';
import { ActionType, NATIVE_INPUT_ARG } from '@reticlehq/core';
import { assertNativeInputSupported, NATIVE_INPUT_UNSUPPORTED } from './act-danger.js';

/**
 * `reticle_act_and_wait` takes `args` as an open record, so `args.native` was ACCEPTED and then
 * dropped: the handler drives the page through the SDK and never reaches the native provider. An
 * agent asking for the one thing a synthetic click cannot do — a file picker, the clipboard, an
 * `isTrusted`-gated handler — got a synthetic click and a result that read like success.
 *
 * A silently ignored argument is a false promise. These pin the refusal, and pin that it names the
 * route that does work rather than just saying no.
 */
describe('a native-input request the act-then-wait path cannot honour is refused', () => {
  it('throws rather than dropping args.native on the floor', () => {
    expect(() => assertNativeInputSupported({ [NATIVE_INPUT_ARG]: true })).toThrow(
      NATIVE_INPUT_UNSUPPORTED,
    );
  });

  it('names the tool that CAN do it — a refusal without a route is a dead end', () => {
    expect(NATIVE_INPUT_UNSUPPORTED).toContain('reticle_act');
    expect(NATIVE_INPUT_UNSUPPORTED).toContain(NATIVE_INPUT_ARG);
  });

  it('lets every ordinary action through untouched', () => {
    expect(() => assertNativeInputSupported({})).not.toThrow();
    expect(() => assertNativeInputSupported({ value: 'hello' })).not.toThrow();
    // Only an explicit `true` is a request. A falsy value is not one, and must not be refused.
    expect(() => assertNativeInputSupported({ [NATIVE_INPUT_ARG]: false })).not.toThrow();
  });

  /** The constant is shared with the real-input driver, so the two can never disagree on spelling. */
  it('uses the same argument name the native driver reads', () => {
    expect(NATIVE_INPUT_ARG).toBe('native');
    expect(ActionType.CLICK).toBe('click');
  });
});
