import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACTIVATION_TICKET_VERSION,
  ActivationRefusal,
  HelloEnv,
  HelloInstrumentation,
  HelloScope,
  PRODUCTION_ACTIVATE_PARAM,
  signActivationTicket,
  toBase64Url,
  type ActivationTicketPayload,
} from '@reticlehq/core';
import { activate, type ActivateHost } from './activate.js';
import { helloMode } from './connect-options.js';

const ORIGIN = 'https://app.example.com';
const NOW = 1_800_000_000_000;

const payload = (over: Partial<ActivationTicketPayload> = {}): ActivationTicketPayload => ({
  v: ACTIVATION_TICKET_VERSION,
  nonce: 'nonce-123',
  origin: ORIGIN,
  bridge: 'wss://bridge.reticle.sh/reticle',
  scope: HelloScope.OBSERVE,
  exp: NOW + 60_000,
  ...over,
});

async function keys(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  // Typed as unknown: the WebCrypto typings here do not know Ed25519 generates a pair.
  const generated: unknown = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]);
  const pair = generated as { privateKey: CryptoKey; publicKey: CryptoKey };
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
}

function fakeHost(href: string) {
  const connect = vi.fn();
  const importer = vi.fn(() => Promise.resolve({ connect }));
  const replaceState = vi.fn();
  const warn = vi.fn();
  const url = new URL(href);
  const host: ActivateHost = {
    location: { href, origin: url.origin },
    history: { replaceState, state: null },
    now: () => NOW,
    connect: importer,
    warn,
  };
  return { host, connect, importer, replaceState, warn };
}

const withTicket = (ticket: string) =>
  `${ORIGIN}/dashboard?tab=1&${PRODUCTION_ACTIVATE_PARAM}=${encodeURIComponent(ticket)}`;

// jsdom has no SubtleCrypto. A browser does; Node's is the same API.
beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});

describe('activate', () => {
  it('without the parameter it does nothing: no import, no connect, no history, no globals', async () => {
    const before = Object.keys(globalThis).sort();
    const storage = localStorage.length;
    const body = document.documentElement.outerHTML;
    const f = fakeHost(`${ORIGIN}/dashboard?tab=1`);
    expect(await activate({ publicKey: 'unused' }, f.host)).toBe(false);
    expect(f.importer).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.replaceState).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
    expect(Object.keys(globalThis).sort()).toEqual(before);
    expect(localStorage.length).toBe(storage);
    expect(document.documentElement.outerHTML).toBe(body);
  });

  it('the page default reads the real address bar and does nothing without the parameter', async () => {
    const before = Object.keys(globalThis).sort();
    expect(await activate({ publicKey: 'unused' })).toBe(false);
    expect(Object.keys(globalThis).sort()).toEqual(before);
  });

  it('a valid ticket strips the parameter, then connects in production with the nonce', async () => {
    const k = await keys();
    const ticket = await signActivationTicket(k.privateKey, payload());
    const f = fakeHost(withTicket(ticket));
    expect(await activate({ publicKey: k.publicKey }, f.host)).toBe(true);
    expect(f.replaceState).toHaveBeenCalledWith(null, '', `${ORIGIN}/dashboard?tab=1`);
    expect(f.connect).toHaveBeenCalledWith({
      url: 'wss://bridge.reticle.sh/reticle',
      token: 'nonce-123',
      env: HelloEnv.PRODUCTION,
      scope: HelloScope.OBSERVE,
      allowInProduction: true,
      allowNonLocalhost: true,
    });
    // The HELLO this sends says the app installed the SDK, not that a verifier injected it.
    const options = f.connect.mock.calls[0]?.[0] as Parameters<typeof helloMode>[0];
    expect(helloMode(options).instrumentation).toBeUndefined();
    expect(HelloInstrumentation.INSTALLED).toBe('installed');
  });

  it.each([
    ['expired', payload({ exp: NOW }), undefined, ActivationRefusal.EXPIRED],
    [
      'another origin',
      payload({ origin: 'https://evil.example.com' }),
      undefined,
      ActivationRefusal.WRONG_ORIGIN,
    ],
    [
      'a remote ws:// bridge',
      payload({ bridge: 'ws://bridge.reticle.sh/reticle' }),
      undefined,
      ActivationRefusal.INSECURE_BRIDGE,
    ],
    ['tampered', payload(), 'tamper', ActivationRefusal.BAD_SIGNATURE],
  ] as const)('a %s ticket is stripped and loads nothing', async (_name, body, mode, reason) => {
    const k = await keys();
    let ticket = await signActivationTicket(k.privateKey, body);
    if ('tamper' === mode) ticket = `${ticket.slice(0, -4)}AAAA`;
    const f = fakeHost(withTicket(ticket));
    expect(await activate({ publicKey: k.publicKey }, f.host)).toBe(false);
    expect(f.replaceState).toHaveBeenCalledTimes(1);
    expect(f.importer).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(String(f.warn.mock.calls[0]?.[0])).toContain(reason);
  });

  it('a malformed ticket loads nothing', async () => {
    const f = fakeHost(withTicket('garbage'));
    expect(await activate({ publicKey: 'AAAA' }, f.host)).toBe(false);
    expect(f.importer).not.toHaveBeenCalled();
  });
});
