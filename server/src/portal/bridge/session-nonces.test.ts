import { describe, expect, it } from 'vitest';
import { SessionNonces, SESSION_NONCE_TTL_MS } from './session-nonces.js';

const ORIGIN = 'https://app.example.com';

function registry(start = 1_000): { nonces: SessionNonces; advance: (ms: number) => void } {
  let now = start;
  let n = 0;
  const nonces = new SessionNonces({
    clock: () => now,
    random: () => `nonce-${String((n += 1))}`,
  });
  return {
    nonces,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('session nonces', () => {
  it('mints a token that a HELLO can redeem, with a 60-minute default TTL', () => {
    const { nonces } = registry();
    const minted = nonces.mint({ origin: ORIGIN });
    expect(minted.expiresAt).toBe(1_000 + SESSION_NONCE_TTL_MS);
    expect(SESSION_NONCE_TTL_MS).toBe(60 * 60 * 1000);
    expect(nonces.redeem(minted.nonce, 'tab-1')).toMatchObject({ origin: ORIGIN });
  });

  it('redeems a value it never minted as nothing', () => {
    const { nonces } = registry();
    nonces.mint({});
    expect(nonces.redeem('guessed', 'tab-1')).toBeUndefined();
    expect(nonces.redeem(undefined, 'tab-1')).toBeUndefined();
  });

  it('is single-use: a second tab presenting the same nonce is refused', () => {
    const { nonces } = registry();
    const { nonce } = nonces.mint({});
    expect(nonces.redeem(nonce, 'tab-1')).toBeDefined();
    expect(nonces.redeem(nonce, 'tab-2')).toBeUndefined();
  });

  it('lets the SAME tab reconnect under its nonce, because a reload sends a fresh HELLO', () => {
    const { nonces } = registry();
    const { nonce } = nonces.mint({});
    nonces.redeem(nonce, 'tab-1');
    expect(nonces.redeem(nonce, 'tab-1')).toBeDefined();
  });

  it('refuses a nonce after it expires, redeemed or not', () => {
    const { nonces, advance } = registry();
    const unused = nonces.mint({ ttlMs: 1_000 });
    const used = nonces.mint({ ttlMs: 1_000 });
    nonces.redeem(used.nonce, 'tab-1');
    advance(1_000);
    expect(nonces.redeem(unused.nonce, 'tab-1')).toBeUndefined();
    expect(nonces.redeem(used.nonce, 'tab-1')).toBeUndefined();
  });

  it('admits the origin of a live nonce only', () => {
    const { nonces, advance } = registry();
    nonces.mint({ origin: ORIGIN, ttlMs: 1_000 });
    expect(nonces.admitsOrigin(ORIGIN)).toBe(true);
    expect(nonces.admitsOrigin('https://evil.example')).toBe(false);
    advance(1_000);
    expect(nonces.admitsOrigin(ORIGIN)).toBe(false);
  });
});
