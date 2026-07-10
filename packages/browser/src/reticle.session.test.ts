import { describe, it, expect } from 'vitest';
import { SESSION_AUTO, TRANSPORT_LIMITS } from '@reticlehq/core';
import { connectionPolicy, resolveSessionLabel, shouldBlockProduction } from './reticle.js';

describe('resolveSessionLabel', () => {
  const gen = (): string => 'unique-123';

  it('generates a unique per-tab id when no label is given', () => {
    expect(resolveSessionLabel(undefined, gen)).toBe('unique-123');
  });

  it('generates a unique per-tab id for the "auto" sentinel', () => {
    expect(resolveSessionLabel(SESSION_AUTO, gen)).toBe('unique-123');
  });

  it('uses an explicit label verbatim so tabs can intentionally share', () => {
    expect(resolveSessionLabel('alianpost', gen)).toBe('alianpost');
  });
});

describe('connectionPolicy', () => {
  it('allows local pages and local bridges without a token', () => {
    expect(connectionPolicy('localhost', 'ws://127.0.0.1:4400/reticle', false, undefined)).toEqual({
      allowed: true,
    });
  });

  it('requires explicit opt-in and a token outside localhost', () => {
    expect(connectionPolicy('app.example', 'wss://bridge.example/reticle', false, 'token')).toEqual(
      {
        allowed: false,
        reason:
          'Reticle is disabled outside localhost unless allowNonLocalhost is explicitly enabled',
      },
    );
    expect(
      connectionPolicy('app.example', 'wss://bridge.example/reticle', true, undefined),
    ).toEqual({
      allowed: false,
      reason: 'a pairing token is required outside localhost',
    });
    expect(connectionPolicy('app.example', 'wss://bridge.example/reticle', true, 'token')).toEqual({
      allowed: true,
    });
  });

  it('requires encrypted transport for a non-local bridge', () => {
    expect(connectionPolicy('localhost', 'ws://bridge.example/reticle', true, 'token')).toEqual({
      allowed: false,
      reason: 'a non-local Reticle bridge must use wss://',
    });
  });

  it('does not treat loopback-lookalike DNS names as localhost', () => {
    expect(
      connectionPolicy('127.evil.example', 'ws://127.0.0.1:4400/reticle', false, undefined),
    ).toEqual({
      allowed: false,
      reason:
        'Reticle is disabled outside localhost unless allowNonLocalhost is explicitly enabled',
    });
  });

  it('rejects tokens beyond the wire-schema limit before connecting', () => {
    expect(
      connectionPolicy(
        'localhost',
        'ws://127.0.0.1:4400/reticle',
        false,
        'x'.repeat(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH + 1),
      ).allowed,
    ).toBe(false);
  });

  it('rejects non-WebSocket bridge URLs', () => {
    expect(connectionPolicy('localhost', 'javascript:alert(1)', true, 'token').allowed).toBe(false);
  });
});

describe('shouldBlockProduction', () => {
  it('blocks a production build by default', () => {
    expect(shouldBlockProduction('production', false)).toBe(true);
  });

  it('allows dev/test/undefined NODE_ENV (the normal dev-only case)', () => {
    expect(shouldBlockProduction('development', false)).toBe(false);
    expect(shouldBlockProduction('test', false)).toBe(false);
    expect(shouldBlockProduction(undefined, false)).toBe(false);
  });

  it('honors the explicit allowInProduction override', () => {
    expect(shouldBlockProduction('production', true)).toBe(false);
  });
});
