import { registerCapabilities, setCapabilitiesListener } from '@/registry/capabilities.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerAdapter,
  elementHasHoverHandlers,
  identifyComponent,
  type ReticleAdapter,
} from './adapters.js';

const adapters = ((
  globalThis as unknown as { __reticleAdapters?: ReticleAdapter[] }
).__reticleAdapters ??= []);

function clearAdapters(): void {
  adapters.length = 0;
}

beforeEach(clearAdapters);
afterEach(clearAdapters);

describe('elementHasHoverHandlers', () => {
  it('returns false when no adapter is installed', () => {
    expect(elementHasHoverHandlers(document.createElement('div'))).toBe(false);
  });

  it('returns true when an adapter reports handlers for the element', () => {
    registerAdapter({
      name: 'mock-hover',
      identify: () => null,
      hasHoverHandlers: (el) => 'BUTTON' === el.tagName,
    });
    expect(elementHasHoverHandlers(document.createElement('button'))).toBe(true);
    expect(elementHasHoverHandlers(document.createElement('div'))).toBe(false);
  });

  it('skips adapters that do not implement the probe', () => {
    registerAdapter({ name: 'mock-noprobe', identify: () => null });
    expect(elementHasHoverHandlers(document.createElement('button'))).toBe(false);
  });
});

/**
 * `hasCapabilities` rides in the HELLO, which goes out at connect(). Registering capabilities
 * deliberately happens AFTER connect — `registerStore` needs a live SDK to subscribe through — so
 * without a notification an app that declared its entire testable surface still appeared to the
 * agent as having none, permanently. All six real apps reported `hasCapabilities: false`.
 */
describe('registerCapabilities notifies, so the bridge learns about a late registration', () => {
  afterEach(() => setCapabilitiesListener(undefined));

  it('fires the listener when capabilities are registered', () => {
    let fired = 0;
    setCapabilitiesListener(() => (fired += 1));
    registerCapabilities({ testids: ['pay'] });
    expect(fired).toBe(1);
  });

  it('fires on the bare registry function, not only via reticle.describe', () => {
    // The documented entry point is the bare import; wiring only `describe` would have fixed the
    // path almost nobody uses.
    let fired = 0;
    setCapabilitiesListener(() => (fired += 1));
    registerCapabilities({ stores: ['app'] });
    registerCapabilities({ signals: ['auth:login'] });
    expect(fired).toBe(2);
  });

  it('is safe with no listener set', () => {
    setCapabilitiesListener(undefined);
    expect(() => registerCapabilities({ testids: ['x'] })).not.toThrow();
  });
});

// docs/adapters.md promises a throw is contained; the registry did not contain it, so a third-party
// adapter that threw took the whole snapshot down, and one returning undefined was passed through
// as a component and crashed the reader of `componentStack`.
describe('a misbehaving adapter costs one component name, never the page', () => {
  const identified = { name: 'Pay', componentStack: ['Pay'] };

  it('skips an adapter that throws and asks the next one', () => {
    registerAdapter({
      name: 'thrower',
      identify: () => {
        throw new Error('boom');
      },
    });
    registerAdapter({ name: 'good', identify: () => identified });
    expect(identifyComponent(document.createElement('button'))).toEqual(identified);
  });

  it('treats undefined as not identified', () => {
    registerAdapter({ name: 'vague', identify: () => undefined } as unknown as ReticleAdapter);
    expect(identifyComponent(document.createElement('button'))).toBeNull();
  });
});
