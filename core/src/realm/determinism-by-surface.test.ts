import { describe, it, expect } from 'vitest';
import { Surface } from 'open-verification';
import { determinismFor } from './registry.js';

/**
 * How a subject may be DRIVEN is a property of the surface, not of one realm object.
 *
 * A realm object is built only by the conformance client, so server code that needs to know how a
 * subject may be driven has no realm to ask. The profile belongs to the KIND of surface, so it
 * lives beside the other facts about kinds, where anything can reach it.
 *
 * `mayResumeByReplayingPrefix` used to live here too, and the two resume assertions with it. Its
 * only caller was `replay { from: N }`, which nothing could reach from any surface, and that whole
 * path has been deleted rather than wired. The PROFILES stay: `replayPrefix` is a published fact
 * about each surface that the next caller will want, and the completeness check below is what stops
 * a new surface arriving without one.
 */
describe('determinismFor', () => {
  it('gives the web profile: a prefix re-drive is free', () => {
    expect(determinismFor(Surface.WEB).replayPrefix).toBe('free');
  });

  it('gives desktop the same, because it is a browser in a shell', () => {
    expect(determinismFor(Surface.DESKTOP).replayPrefix).toBe('free');
  });

  // A service COMMITS: a POST is not idempotent, so a prefix re-drive there is a defect rather
  // than a convenience. The profile says so, and says so whether or not anything reads it today.
  it('does not call a prefix re-drive free where the subject commits', () => {
    expect(determinismFor(Surface.SERVICE).replayPrefix).not.toBe('free');
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
