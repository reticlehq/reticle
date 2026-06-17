import { describe, it, expect } from 'vitest';
import { SESSION_AUTO, TRANSPORT_LIMITS } from '@syrin/iris-protocol';
import { connectionPolicy, resolveSessionLabel } from './iris.js';

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
    expect(connectionPolicy('localhost', 'ws://127.0.0.1:4400/iris', false, undefined)).toEqual({
      allowed: true,
    });
  });

  it('requires explicit opt-in and a token outside localhost', () => {
    expect(connectionPolicy('app.example', 'wss://bridge.example/iris', false, 'token')).toEqual({
      allowed: false,
      reason: 'Iris is disabled outside localhost unless allowNonLocalhost is explicitly enabled',
    });
    expect(connectionPolicy('app.example', 'wss://bridge.example/iris', true, undefined)).toEqual({
      allowed: false,
      reason: 'a pairing token is required outside localhost',
    });
    expect(connectionPolicy('app.example', 'wss://bridge.example/iris', true, 'token')).toEqual({
      allowed: true,
    });
  });

  it('requires encrypted transport for a non-local bridge', () => {
    expect(connectionPolicy('localhost', 'ws://bridge.example/iris', true, 'token')).toEqual({
      allowed: false,
      reason: 'a non-local Iris bridge must use wss://',
    });
  });

  it('does not treat loopback-lookalike DNS names as localhost', () => {
    expect(
      connectionPolicy('127.evil.example', 'ws://127.0.0.1:4400/iris', false, undefined),
    ).toEqual({
      allowed: false,
      reason: 'Iris is disabled outside localhost unless allowNonLocalhost is explicitly enabled',
    });
  });

  it('rejects tokens beyond the wire-schema limit before connecting', () => {
    expect(
      connectionPolicy(
        'localhost',
        'ws://127.0.0.1:4400/iris',
        false,
        'x'.repeat(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH + 1),
      ).allowed,
    ).toBe(false);
  });

  it('rejects non-WebSocket bridge URLs', () => {
    expect(connectionPolicy('localhost', 'javascript:alert(1)', true, 'token').allowed).toBe(false);
  });
});
