import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRedactionPolicy,
  resetActiveRedactionPolicy,
  setActiveRedactionPolicy,
} from '@reticlehq/core';
import { sanitizeForTransport } from './serialization.js';
import { readStorage } from '../observers/storage.js';
import { nativeWarn } from '../timers/native-console.js';
import { reticle } from '../index.js';

// The SDK's own diagnostics deliberately go through the console reference captured at module load,
// so they never become CONSOLE_WARN events the agent then reads back as app output. That also means
// spying on `console.warn` cannot see them — mock the module instead.
vi.mock('../timers/native-console.js', () => ({ nativeWarn: vi.fn() }));

afterEach(() => {
  resetActiveRedactionPolicy();
  vi.mocked(nativeWarn).mockClear();
});

/**
 * The property that makes this feature worth having: the config is read AMBIENTLY, so configuring it
 * once changes every redacting call site at once. Threading a policy parameter through them instead
 * would mean a new call site could silently opt out — and a redaction path that quietly does not
 * apply is the exact failure this option exists to fix.
 */
describe('the configured rule reaches the paths that redact', () => {
  it('redacts a declared key through the transport serializer', () => {
    const state = { licenceKey: 'LK-9', label: 'ok' };
    expect(sanitizeForTransport(state)).toEqual({ licenceKey: 'LK-9', label: 'ok' });

    setActiveRedactionPolicy(buildRedactionPolicy({ keys: ['licenceKey'] }));
    expect(sanitizeForTransport(state)).toEqual({ licenceKey: '[REDACTED]', label: 'ok' });
  });

  it('un-redacts an exempted key through the transport serializer', () => {
    const state = { session_id: 'abc' };
    expect(sanitizeForTransport(state)).toEqual({ session_id: '[REDACTED]' });

    setActiveRedactionPolicy(buildRedactionPolicy({ allow: ['session_id'] }));
    expect(sanitizeForTransport(state)).toEqual({ session_id: 'abc' });
  });

  it('redacts a declared key nested deep in app state, not only at the top level', () => {
    setActiveRedactionPolicy(buildRedactionPolicy({ keys: ['licenceKey'] }));
    expect(sanitizeForTransport({ tenant: { config: { licenceKey: 'LK-9' } } })).toEqual({
      tenant: { config: { licenceKey: '[REDACTED]' } },
    });
  });

  it('redacts a declared key in the storage observer, a different call site entirely', () => {
    window.localStorage.clear();
    window.localStorage.setItem('licenceKey', 'LK-9');
    try {
      expect(readStorage('local')).toEqual({ licenceKey: 'LK-9' });

      setActiveRedactionPolicy(buildRedactionPolicy({ keys: ['licenceKey'] }));
      expect(readStorage('local')).toEqual({ licenceKey: '[REDACTED]' });
    } finally {
      window.localStorage.clear();
    }
  });
});

describe('connect installs the policy', () => {
  it('applies redact from connect options, and warns about an exemption that un-redacts a credential', () => {
    try {
      reticle.connect({
        session: 'redaction-test',
        redact: { keys: ['licenceKey'], allow: ['session_id'] },
      });
      expect(sanitizeForTransport({ licenceKey: 'LK-9', session_id: 'abc' })).toEqual({
        licenceKey: '[REDACTED]',
        session_id: 'abc',
      });
      expect(vi.mocked(nativeWarn).mock.calls.flat().join(' ')).toContain('session_id');
    } finally {
      reticle.disconnect();
    }
  });
});
