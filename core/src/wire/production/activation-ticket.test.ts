// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HelloScope } from './hello-mode.js';
import {
  ActivationRefusal,
  ACTIVATION_TICKET_VERSION,
  type ActivationTicketPayload,
  signActivationTicket,
  toBase64Url,
  verifyActivationTicket,
} from './activation-ticket.js';

const ORIGIN = 'https://app.example.com';
const NOW = 1_800_000_000_000;

const payload = (over: Partial<ActivationTicketPayload> = {}): ActivationTicketPayload => ({
  v: ACTIVATION_TICKET_VERSION,
  nonce: 'nonce-123',
  origin: ORIGIN,
  bridge: 'wss://bridge.reticle.sh/reticle',
  scope: HelloScope.ACT,
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

const check = (ticket: string, publicKey: string, origin = ORIGIN) =>
  verifyActivationTicket(ticket, { publicKey, origin, now: NOW });

describe('activation ticket', () => {
  it('a signed ticket verifies and returns its payload', async () => {
    const k = await keys();
    const ticket = await signActivationTicket(k.privateKey, payload());
    expect(await check(ticket, k.publicKey)).toEqual({ ok: true, payload: payload() });
  });

  it('a ticket signed by another key is refused', async () => {
    const signer = await keys();
    const other = await keys();
    const ticket = await signActivationTicket(signer.privateKey, payload());
    expect(await check(ticket, other.publicKey)).toEqual({
      ok: false,
      reason: ActivationRefusal.BAD_SIGNATURE,
    });
  });

  it('a tampered payload is refused', async () => {
    const k = await keys();
    const ticket = await signActivationTicket(k.privateKey, payload());
    const [, signature] = ticket.split('.');
    const forged = `${toBase64Url(new TextEncoder().encode(JSON.stringify(payload({ scope: HelloScope.ACT, nonce: 'other' }))))}.${String(signature)}`;
    expect(await check(forged, k.publicKey)).toEqual({
      ok: false,
      reason: ActivationRefusal.BAD_SIGNATURE,
    });
  });

  it('an expired ticket is refused', async () => {
    const k = await keys();
    const ticket = await signActivationTicket(k.privateKey, payload({ exp: NOW }));
    expect(await check(ticket, k.publicKey)).toEqual({
      ok: false,
      reason: ActivationRefusal.EXPIRED,
    });
  });

  it('a ticket for another origin is refused', async () => {
    const k = await keys();
    const ticket = await signActivationTicket(k.privateKey, payload());
    expect(await check(ticket, k.publicKey, 'https://evil.example.com')).toEqual({
      ok: false,
      reason: ActivationRefusal.WRONG_ORIGIN,
    });
  });

  it('a remote ws:// bridge is refused, a loopback one is allowed', async () => {
    const k = await keys();
    const remote = await signActivationTicket(
      k.privateKey,
      payload({ bridge: 'ws://bridge.reticle.sh/reticle' }),
    );
    expect(await check(remote, k.publicKey)).toEqual({
      ok: false,
      reason: ActivationRefusal.INSECURE_BRIDGE,
    });
    const loopback = await signActivationTicket(
      k.privateKey,
      payload({ bridge: 'ws://127.0.0.1:4400/reticle' }),
    );
    expect((await check(loopback, k.publicKey)).ok).toBe(true);
  });

  it.each([
    '',
    'abc',
    'a.b.c',
    '!!!.???',
    `${toBase64Url(new TextEncoder().encode('{"v":1}'))}.AA`,
  ])('a malformed ticket %j is refused', async (ticket) => {
    const k = await keys();
    expect(await check(ticket, k.publicKey)).toEqual({
      ok: false,
      reason: ActivationRefusal.MALFORMED,
    });
  });

  it('a malformed public key is refused, never thrown', async () => {
    const k = await keys();
    const ticket = await signActivationTicket(k.privateKey, payload());
    expect(await check(ticket, 'not-a-key')).toEqual({
      ok: false,
      reason: ActivationRefusal.BAD_SIGNATURE,
    });
  });
});
