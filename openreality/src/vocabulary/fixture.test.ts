import { describe, expect, it } from 'vitest';
import { FixtureRefSchema, fixtureIsUsable } from './fixture.js';
import { Surface } from './subject.js';

/**
 * "Get the subject into the state every flow in this suite assumes."
 *
 * A suite of fifty flows that each log in from cold spends most of its time proving the login works,
 * fifty times, and the flow that actually LOGS OUT leaves every flow after it signed out — no
 * navigation fixes that, because the problem is not where the subject is, it is what it holds.
 *
 * A fixture is domain-specific and cannot live in the protocol as anything but a reference: a saved
 * `storageState` on the web, a seeded simulator on mobile, a save file in a game, rows and a
 * migration in a service, a homed rig in hardware. So the protocol declares THAT one exists and WHEN
 * it is applied; the realm declares how.
 *
 * The subject and epoch are what stop it being a footgun. State captured from a build that has since
 * been rewritten is not a shortcut, it is a green flow standing on a session the current code would
 * never have issued — the same reason every piece of evidence here carries an epoch.
 */

const ref = {
  id: 'authed-operator',
  subject: { surface: Surface.WEB, instance: 'app', epoch: 7 },
  capturedAt: 1000,
};

describe('a reference to state somebody saved earlier', () => {
  it('carries the subject and epoch it was captured from', () => {
    expect(FixtureRefSchema.parse(ref).subject.epoch).toBe(7);
  });

  it('refuses one with no subject — state from nowhere cannot be checked against anything', () => {
    const { subject: _gone, ...noSubject } = ref;
    expect(() => FixtureRefSchema.parse(noSubject)).toThrow();
  });
});

describe('whether a saved fixture may still be applied', () => {
  it('is usable against the epoch it was captured from', () => {
    expect(fixtureIsUsable(ref, { surface: Surface.WEB, instance: 'app', epoch: 7 })).toBe(true);
  });

  it('is NOT usable once the subject has been rewritten', () => {
    // The whole reason the epoch travels. A session token minted by code that no longer exists makes
    // every flow after it green against a state the current build would never have issued.
    expect(fixtureIsUsable(ref, { surface: Surface.WEB, instance: 'app', epoch: 8 })).toBe(false);
  });

  it('is NOT usable against a different instance', () => {
    expect(fixtureIsUsable(ref, { surface: Surface.WEB, instance: 'staging', epoch: 7 })).toBe(
      false,
    );
  });

  it('is NOT usable against a different surface, however alike they look', () => {
    // A desktop shell and a browser tab can run the same application and still not share a cookie
    // jar. Same code, different subject.
    expect(fixtureIsUsable(ref, { surface: Surface.DESKTOP, instance: 'app', epoch: 7 })).toBe(
      false,
    );
  });

  it('is usable when neither side claims an epoch, rather than refusing everything', () => {
    // A realm that cannot tell when it was rewritten says so by omitting the epoch. Treating that as
    // "never reusable" would punish the honest omission and push implementers to invent a number.
    const noEpoch = { ...ref, subject: { surface: Surface.WEB, instance: 'app' } };
    expect(fixtureIsUsable(noEpoch, { surface: Surface.WEB, instance: 'app' })).toBe(true);
  });
});
