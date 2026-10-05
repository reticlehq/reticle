import { describe, it, expect } from 'vitest';
import { SESSION_AUTO, TRANSPORT_LIMITS } from '@reticlehq/core';
import {
  connectionPolicy,
  resolveSessionLabel,
  shouldBlockProduction,
  withBridgePath,
} from './reticle.js';

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

  // A desktop webview is not a remote website — it is a local app whose document happens not to be
  // served over http://localhost. The localhost gate exists to stop a REMOTE PAGE driving a local
  // bridge; applying it to file:// or tauri:// blocks the desktop case it was never aimed at.
  const DESKTOP_PAGES: { label: string; protocol: string; hostname: string }[] = [
    { label: 'packaged Electron (loadFile)', protocol: 'file:', hostname: '' },
    { label: 'Electron custom protocol', protocol: 'app:', hostname: '.' },
    { label: 'Tauri macOS/Linux', protocol: 'tauri:', hostname: 'localhost' },
    { label: 'Tauri Windows', protocol: 'http:', hostname: 'tauri.localhost' },
  ];

  for (const page of DESKTOP_PAGES) {
    it(`allows a local desktop webview to reach a loopback bridge: ${page.label}`, () => {
      expect(
        connectionPolicy(
          page.hostname,
          'ws://127.0.0.1:4400/reticle',
          false,
          undefined,
          page.protocol,
        ),
      ).toEqual({ allowed: true });
    });
  }

  it('still blocks a remote https page even though its bridge is loopback', () => {
    expect(
      connectionPolicy('evil.example', 'ws://127.0.0.1:4400/reticle', false, undefined, 'https:')
        .allowed,
    ).toBe(false);
  });

  it('does not let a desktop protocol unlock a REMOTE bridge — that still needs the opt-in', () => {
    expect(
      connectionPolicy('localhost', 'wss://bridge.example/reticle', false, 'token', 'tauri:')
        .allowed,
    ).toBe(false);
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

describe('withBridgePath', () => {
  it('adds the bridge path to a pathless ws URL', () => {
    expect(withBridgePath('ws://localhost:4400')).toEqual({
      url: 'ws://localhost:4400/reticle',
      adjusted: true,
    });
    expect(withBridgePath('ws://localhost:4400/')).toEqual({
      url: 'ws://localhost:4400/reticle',
      adjusted: true,
    });
  });

  it('keeps a wss host, port and query when adding the path', () => {
    expect(withBridgePath('wss://bridge.example:8443?x=1')).toEqual({
      url: 'wss://bridge.example:8443/reticle?x=1',
      adjusted: true,
    });
  });

  it('leaves a URL that already has a path alone', () => {
    expect(withBridgePath('ws://127.0.0.1:4400/reticle')).toEqual({
      url: 'ws://127.0.0.1:4400/reticle',
      adjusted: false,
    });
    expect(withBridgePath('wss://proxy.example/mount/reticle')).toEqual({
      url: 'wss://proxy.example/mount/reticle',
      adjusted: false,
    });
  });

  it('passes through non-ws and unparseable values for connectionPolicy to reject', () => {
    expect(withBridgePath('javascript:alert(1)').adjusted).toBe(false);
    expect(withBridgePath('not a url')).toEqual({ url: 'not a url', adjusted: false });
  });
});
