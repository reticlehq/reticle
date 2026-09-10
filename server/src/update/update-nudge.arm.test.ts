/**
 * Getting a published release in front of the people running an old one.
 *
 * Measured over a day of real telemetry: the entire install base was on 2.3.0 or 2.2.1 and NOBODY
 * was on the release published the day before — the one carrying the fix for a lost first-load
 * connect on every Vite app. Adoption was zero. Two mechanical reasons, both here:
 *
 * 1. The nudge is armed by a network check fired 8s AFTER the daemon boots, and it is delivered by
 *    riding a tool result. But half the sessions that touch Reticle at all make exactly ONE tool
 *    call — usually within the first seconds — so the check had not finished and the one chance to
 *    tell them was gone. The answer from yesterday is already cached on disk; arm from it
 *    immediately and let the network refresh in the background.
 *
 * 2. `updateAvailable` was a plain `!==`, so anyone running a version NEWER than the published one
 *    (a prerelease, a local build, a rollback in progress) was told to "update" to something older.
 *    A nudge that tells you to downgrade is one you learn to ignore, and this is the mechanism the
 *    whole adoption story rests on.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  armUpdateNudgeFrom,
  takeUpdateNudge,
  resetUpdateNudge,
  updateTarget,
} from './update-nudge.js';

beforeEach(() => resetUpdateNudge());

describe('armUpdateNudgeFrom — the cached answer, available on the FIRST tool call', () => {
  it('arms immediately when the cache says a newer version exists', () => {
    armUpdateNudgeFrom({ latestVersion: '2.4.0', updateAvailable: true }, '2.3.0');
    const nudge = takeUpdateNudge();
    expect(nudge?.latestVersion).toBe('2.4.0');
    expect(nudge?.currentVersion).toBe('2.3.0');
    expect(nudge?.command).toContain('reticle update');
  });

  it('never nudges toward an OLDER version — a downgrade prompt is how a nudge gets ignored', () => {
    // A 2.4.1 build against a 2.4.0 registry: the honest answer is silence.
    armUpdateNudgeFrom({ latestVersion: '2.4.0', updateAvailable: true }, '2.4.1');
    expect(takeUpdateNudge()).toBeUndefined();
  });

  it('says nothing when the versions match', () => {
    armUpdateNudgeFrom({ latestVersion: '2.4.0', updateAvailable: false }, '2.4.0');
    expect(takeUpdateNudge()).toBeUndefined();
  });

  it('says nothing with no cache at all (first ever run)', () => {
    armUpdateNudgeFrom(null, '2.3.0');
    expect(takeUpdateNudge()).toBeUndefined();
  });

  it('compares numerically, not as strings — 2.10.0 is newer than 2.9.0', () => {
    // The string comparison this replaces reads "2.10.0" < "2.9.0" and goes quiet on a real release.
    armUpdateNudgeFrom({ latestVersion: '2.10.0', updateAvailable: true }, '2.9.0');
    expect(takeUpdateNudge()?.latestVersion).toBe('2.10.0');
  });

  it('handles a prerelease suffix without crashing or nudging backwards', () => {
    armUpdateNudgeFrom({ latestVersion: '2.4.0', updateAvailable: true }, '2.4.0-rc.1');
    // 2.4.0 final IS newer than its own release candidate.
    expect(takeUpdateNudge()?.latestVersion).toBe('2.4.0');
  });

  it('is still delivered only ONCE', () => {
    armUpdateNudgeFrom({ latestVersion: '2.4.0', updateAvailable: true }, '2.3.0');
    expect(takeUpdateNudge()).toBeDefined();
    expect(takeUpdateNudge()).toBeUndefined();
  });
});

/**
 * `reticle update` would install a DOWNGRADE.
 *
 * A real user reported this on 2026-08-06: "Version comparison is reversed in the update path — both
 * the `update_available` banner and `reticle update` report the current and target versions swapped,
 * so an upgrade is described as a downgrade." They hit it with npm-latest at 2.3.0 against a stale
 * npx-cached daemon at 2.2.1.
 *
 * The banner half is fixed by isNewerVersion above. The COMMAND half was not: `handleUpdate` gates
 * on `manifest.updateAvailable`, which is a plain `latest !== current`, so whenever the registry's
 * latest is older than the running build — a prerelease, a local build, a rollback in progress, a
 * stale cache — it reports the move and then actually installs the older version.
 */
describe('updateTarget — what `reticle update` should actually install', () => {
  it('returns the newer version when there is one', () => {
    expect(updateTarget({ updateAvailable: true, latestVersion: '2.4.0' }, '2.3.0')).toBe('2.4.0');
  });

  it('returns nothing when the registry is BEHIND us — never install a downgrade', () => {
    expect(
      updateTarget({ updateAvailable: true, latestVersion: '2.1.0' }, '2.4.0'),
    ).toBeUndefined();
  });

  it('returns nothing when already current', () => {
    expect(
      updateTarget({ updateAvailable: false, latestVersion: '2.4.0' }, '2.4.0'),
    ).toBeUndefined();
  });

  it('returns nothing when the registry answer is missing', () => {
    expect(updateTarget({ updateAvailable: true }, '2.4.0')).toBeUndefined();
  });
});
