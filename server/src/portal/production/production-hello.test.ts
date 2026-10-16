import { describe, expect, it } from 'vitest';
import { HelloEnv, HelloScope } from '@reticlehq/core';
import { admitHello, PRODUCTION_HELLO_REFUSED } from './production-hello.js';
import { ProductionDrive } from './production-drive.js';

const granted = (scope: HelloScope): ProductionDrive =>
  new ProductionDrive({ scope, expiresAt: Number.MAX_SAFE_INTEGER }, () => 0);
const scopeOf = (admission: ReturnType<typeof admitHello>): HelloScope | undefined =>
  admission.ok ? admission.production?.scope : undefined;

describe('which HELLO may open a production session', () => {
  it('leaves a development HELLO without a production nonce as it was', () => {
    expect(admitHello({}, undefined)).toEqual({ ok: true });
  });

  it('refuses a production HELLO that has no production nonce, whatever token it carried', () => {
    expect(admitHello({ env: HelloEnv.PRODUCTION, scope: HelloScope.ACT }, undefined)).toEqual({
      ok: false,
      reason: PRODUCTION_HELLO_REFUSED,
    });
  });

  it('refuses a production HELLO that does not name its scope', () => {
    expect(admitHello({ env: HelloEnv.PRODUCTION }, granted(HelloScope.ACT)).ok).toBe(false);
  });

  it('opens a production session with the scope the nonce granted', () => {
    const admission = admitHello(
      { env: HelloEnv.PRODUCTION, scope: HelloScope.ACT },
      granted(HelloScope.ACT),
    );
    expect(scopeOf(admission)).toBe(HelloScope.ACT);
  });

  it('lets the page narrow act to observe, and never widen observe to act', () => {
    const drive = granted(HelloScope.ACT);
    const narrowed = admitHello({ env: HelloEnv.PRODUCTION, scope: HelloScope.OBSERVE }, drive);
    expect(scopeOf(narrowed)).toBe(HelloScope.OBSERVE);
    // The same tab reconnecting with `act` stays narrowed.
    const again = admitHello({ env: HelloEnv.PRODUCTION, scope: HelloScope.ACT }, drive);
    expect(scopeOf(again)).toBe(HelloScope.OBSERVE);
    const widened = admitHello(
      { env: HelloEnv.PRODUCTION, scope: HelloScope.ACT },
      granted(HelloScope.OBSERVE),
    );
    expect(scopeOf(widened)).toBe(HelloScope.OBSERVE);
  });

  it('keeps a production nonce production even when the page claims development', () => {
    expect(scopeOf(admitHello({}, granted(HelloScope.ACT)))).toBe(HelloScope.ACT);
  });
});
