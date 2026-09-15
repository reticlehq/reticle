import { describe, expect, it, beforeEach } from 'vitest';
import { Surface } from 'open-verification';
import {
  registerRealm,
  realmOf,
  surfaceOf,
  knownRuntimes,
  resetRegisteredRealms,
} from './registry.js';
import { AppRuntime } from '../telemetry-feedback.js';

/**
 * A domain can add itself without editing this package.
 *
 * `REALMS` is a `Record<AppRuntime, RealmTraits>` and `AppRuntime` is a closed three-value enum, all
 * of them webviews. That shape is deliberate for the shells we ship — leaving one out is a compile
 * error, which is what keeps the table honest — and it is a wall for everybody else: an Android
 * realm, a game realm, a CLI realm cannot be NAMED without a pull request against `@reticlehq/core`.
 * A protocol meant for industries that have never heard of this repository cannot require that.
 *
 * So a runtime may be registered at startup, and the name must carry the `x-` prefix the protocol
 * already uses for every other extension point. That prefix is not decoration: it keeps a
 * third-party realm from silently claiming a name this package might later ship, and it tells a
 * reader instantly which realms are ours and which are somebody's.
 *
 * The built-ins stay exactly as they are — a compile-checked Record, unregisterable, unshadowable.
 * Extension must not mean an adopter can redefine `web`.
 */
describe('registerRealm', () => {
  beforeEach(() => {
    resetRegisteredRealms();
  });

  const traits = {
    surface: Surface.GAME,
    isDesktopShell: false,
    usesWebKit: false,
    ownsCoverageKinds: false,
    hasOwnBaselineDirectory: false,
  };

  it('a registered realm answers with the surface it declared', () => {
    registerRealm('x-godot', { ...traits });
    expect(surfaceOf('x-godot')).toBe(Surface.GAME);
    expect(realmOf('x-godot').surface).toBe(Surface.GAME);
  });

  it('makes a surface reachable that no built-in realm can name', () => {
    // The point of the whole change: `game` was in the protocol and unreachable from a live subject.
    expect(surfaceOf('x-godot')).toBe(Surface.WEB); // before registering
    registerRealm('x-godot', { ...traits });
    expect(surfaceOf('x-godot')).toBe(Surface.GAME);
  });

  it('REFUSES a name without the x- prefix, so nobody squats a name we might ship', () => {
    expect(() => registerRealm('android', { ...traits, surface: Surface.MOBILE })).toThrow(/x-/);
  });

  it('REFUSES to shadow a built-in — an adopter cannot redefine web', () => {
    expect(() => registerRealm(AppRuntime.WEB, { ...traits })).toThrow();
    expect(surfaceOf(AppRuntime.WEB)).toBe(Surface.WEB);
  });

  it('lists what is known, so a daemon can say which realms it understands', () => {
    registerRealm('x-android', { ...traits, surface: Surface.MOBILE });
    const known = knownRuntimes();
    expect(known).toContain(AppRuntime.WEB);
    expect(known).toContain('x-android');
  });

  it('still answers web for a runtime nobody registered', () => {
    // Unchanged: a SubjectRef needs a surface and the handshake carries no other tell.
    expect(surfaceOf('x-never-registered')).toBe(Surface.WEB);
  });
});
