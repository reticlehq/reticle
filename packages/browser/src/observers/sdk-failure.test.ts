import { describe, expect, it, vi } from 'vitest';
import { EventType } from '@reticlehq/core';
import { reportSdkFailure, SdkSite } from './sdk-failure.js';

/**
 * Half of Reticle runs inside the page, and that half was silent: every SDK catch block swallows by
 * design — correctly, since instrumentation must never break the app — so an observer that threw on
 * page load just made the product quieter and nobody ever found out.
 */
describe('reportSdkFailure', () => {
  it('emits over the bridge the SDK is ALREADY connected to — no outbound request of its own', () => {
    const emit = vi.fn();
    reportSdkFailure(emit, SdkSite.NETWORK_OBSERVER, new TypeError('fetch is not extensible'));
    expect(emit).toHaveBeenCalledWith(
      EventType.SDK_FAILED,
      expect.objectContaining({
        site: 'network_observer',
        message: 'fetch is not extensible',
        errorType: 'TypeError',
      }),
    );
  });

  it('handles a thrown non-Error without inventing a type', () => {
    const emit = vi.fn();
    reportSdkFailure(emit, SdkSite.DOM_OBSERVER, 'just a string');
    const payload = emit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload['message']).toBe('just a string');
    expect(payload['errorType']).toBeUndefined();
  });

  it('caps the message rather than forwarding an unbounded string', () => {
    const emit = vi.fn();
    reportSdkFailure(emit, SdkSite.ACTION, new Error('x'.repeat(5000)));
    expect((emit.mock.calls[0]?.[1] as { message: string }).message).toHaveLength(500);
  });

  /** A failure report must never become a second failure — it runs inside someone else's app. */
  it('never throws, even when emit itself throws', () => {
    const emit = vi.fn(() => {
      throw new Error('transport is gone');
    });
    expect(() => reportSdkFailure(emit, SdkSite.TRANSPORT, new Error('boom'))).not.toThrow();
  });
});

/**
 * The robustness half, which matters more than the telemetry half.
 *
 * The observer array in `reticle.ts` used to be built bare: one observer throwing took the WHOLE
 * `connect()` down with it, so a single bad patch on one exotic page meant the app got no
 * instrumentation at all — silently, because the SDK's own catch blocks ensured nobody found out.
 * This models the guard that replaced it.
 */
describe('a throwing observer degrades the SDK instead of collapsing it', () => {
  const guard = (
    emit: ReturnType<typeof vi.fn>,
    site: string,
    install: () => () => void,
  ): (() => void) => {
    try {
      return install();
    } catch (error) {
      reportSdkFailure(emit, site as never, error);
      return () => {};
    }
  };

  it('installs every healthy observer even when one throws', () => {
    const emit = vi.fn();
    const installed: string[] = [];
    const teardowns = [
      guard(emit, SdkSite.NETWORK_OBSERVER, () => {
        installed.push('network');
        return () => {};
      }),
      guard(emit, SdkSite.DOM_OBSERVER, () => {
        throw new Error('MutationObserver is not defined');
      }),
      guard(emit, SdkSite.CONSOLE_OBSERVER, () => {
        installed.push('console');
        return () => {};
      }),
    ];
    // The two healthy observers still ran — previously the throw aborted the whole array.
    expect(installed).toEqual(['network', 'console']);
    expect(teardowns).toHaveLength(3);
    // And the failure is no longer silent.
    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0]?.[1] as { site: string }).site).toBe('dom_observer');
  });

  it('returns a safe no-op teardown for the observer that never installed', () => {
    const emit = vi.fn();
    const teardown = guard(emit, SdkSite.DOM_OBSERVER, () => {
      throw new Error('nope');
    });
    expect(() => teardown()).not.toThrow();
  });
});
