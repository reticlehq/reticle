import { describe, it, expect } from 'vitest';
import { Surface } from '@reticlehq/openreality';
import { determinismFor, mayResumeByReplayingPrefix } from './registry.js';

/**
 * How a subject may be DRIVEN is a property of the surface, not of one realm object.
 *
 * "Resume is nearly free, just re-run the prefix at 27ms a step" is true of a browser and
 * FALSE AND DANGEROUS on hardware, where re-driving moves a physical arm and may not be idempotent.
 * The protocol already has `resumeStrategy` to decide that from a declared profile; what was missing
 * was anywhere for server code to GET the profile, because a realm object is built only by the
 * conformance client and `replay { from: N }` has no realm to ask.
 *
 * The profile belongs to the KIND of surface, so it lives beside the other facts about kinds. That
 * is what makes the rule enforceable today rather than after a realm instance exists on this path.
 */
describe('determinismFor', () => {
  it('gives the web profile: a prefix re-drive is free', () => {
    expect(determinismFor(Surface.WEB).replayPrefix).toBe('free');
  });

  it('gives desktop the same, because it is a browser in a shell', () => {
    expect(determinismFor(Surface.DESKTOP).replayPrefix).toBe('free');
  });

  it('refuses to auto-resume where re-driving a prefix is UNSAFE', () => {
    // A service commits: a POST is not idempotent, so silently re-sending one to reach step N is a
    // defect in the protocol, not a convenience.
    expect(mayResumeByReplayingPrefix(Surface.SERVICE)).toBe(false);
  });

  it('allows it where the profile says it is free', () => {
    expect(mayResumeByReplayingPrefix(Surface.WEB)).toBe(true);
  });

  it('every surface the registry knows has a complete declaration', () => {
    for (const surface of Object.values(Surface)) {
      const profile = determinismFor(surface);
      expect(profile.reset, surface).toBeDefined();
      expect(profile.replayPrefix, surface).toBeDefined();
      expect(profile.observation, surface).toBeDefined();
      expect(profile.actions, surface).toBeDefined();
    }
  });
});
