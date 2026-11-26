import { describe, expect, it } from 'vitest';
import { Surface } from 'open-verification';
import { COMPUTER_RUNTIME, isKnownRealm, isPeerRealm, isRealmName, realmOf } from './registry.js';
import { AppRuntime } from '@/telemetry-feedback.js';

/**
 * A computer peer is not a runtime of the SDK, and it must still keep its name. A session
 * drops a name that is not a realm, and then every question about that session answers as a web
 * page: desktop advice is not given, and web advice is.
 */
describe('a realm that reaches the bridge as a peer', () => {
  it('is a realm name, and is not an SDK runtime', () => {
    expect(isRealmName(COMPUTER_RUNTIME)).toBe(true);
    expect(isKnownRealm(COMPUTER_RUNTIME)).toBe(false);
    expect(isPeerRealm(COMPUTER_RUNTIME)).toBe(true);
    expect(isPeerRealm(AppRuntime.WEB)).toBe(false);
    expect(isPeerRealm(undefined)).toBe(false);
    expect(Object.values(AppRuntime)).not.toContain(COMPUTER_RUNTIME);
  });

  it('has its own facts: a desktop surface, and not a web view in a shell', () => {
    expect(realmOf(COMPUTER_RUNTIME)).toMatchObject({
      surface: Surface.DESKTOP,
      isDesktopShell: false,
    });
  });

  it('keeps the old answers: an SDK runtime is a realm name, and an unknown name is not', () => {
    expect(isRealmName(AppRuntime.TAURI)).toBe(true);
    expect(isRealmName('x-nobody')).toBe(false);
    expect(isRealmName(undefined)).toBe(false);
  });
});
