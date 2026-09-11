import { describe, expect, it } from 'vitest';
import { leaseCaveat } from './lease-availability.js';
import { diagnoseNoSession } from './no-session-diagnosis.js';

/**
 * The escape hatch must not be recommended by the same output that just diagnosed why it cannot work.
 *
 * Reported from the field: `doctor` printed `chromium ✗ wrong revision — the bundled playwright
 * wants chromium-1234; the cache holds chromium-1228` and, in the same breath, "You do not have to
 * wait for the human: reticle_lease {action:"acquire", url}". The lease drives a Reticle-owned
 * browser, so a missing or mismatched Chromium is exactly the case where that advice is the one
 * thing that cannot help — and it is printed by the command that already knows.
 *
 * The reporter also made a point worth encoding: an agent cannot run a ~150MB browser download
 * unprompted on somebody's machine, so this is a hand-back to the human either way, and the message
 * should say so rather than leaving the agent to discover it by trying.
 */
describe('leaseCaveat', () => {
  it('says nothing when the browser is usable, so a healthy install pays nothing', () => {
    expect(leaseCaveat({ exists: true })).toBeUndefined();
  });

  it('says nothing when the probe could not run at all', () => {
    // Absent evidence is not evidence of absence: a probe that did not run must not produce a
    // caveat claiming the browser is missing.
    expect(leaseCaveat(undefined)).toBeUndefined();
  });

  it('warns, and names the install command, when the browser is not there', () => {
    const caveat = leaseCaveat({
      exists: false,
      installCommand: 'npx playwright@1.62.1 install chromium',
    });
    expect(caveat).toBeDefined();
    expect(caveat).toContain('reticle_lease');
    expect(caveat).toContain('npx playwright@1.62.1 install chromium');
  });

  it('says the download is the human’s call, not the agent’s', () => {
    const caveat = leaseCaveat({ exists: false }) ?? '';
    expect(caveat.toLowerCase()).toContain('human');
  });

  it('distinguishes a wrong revision from nothing installed at all', () => {
    const wrongRevision = leaseCaveat({
      exists: false,
      wantedRevision: 'chromium-1234',
      installedRevisions: ['chromium-1228'],
    });
    expect(wrongRevision).toContain('chromium-1234');
    expect(wrongRevision).toContain('chromium-1228');

    const nothingInstalled = leaseCaveat({ exists: false, installedRevisions: [] });
    expect(nothingInstalled).not.toContain('chromium-1228');
  });

  it('never promises the lease will work while saying it cannot', () => {
    const caveat = leaseCaveat({ exists: false }) ?? '';
    expect(caveat).not.toMatch(/you do not have to wait/i);
  });
});

/**
 * The caveat has to reach the message, not merely exist. It was written because the offer and the
 * diagnosis were being made by the same output; a helper nobody calls would reproduce that exactly.
 */
describe('the diagnosis carries the caveat', () => {
  const facts = {
    everConnected: false,
    initialized: true,
    listening: [3000],
    port: 4400,
  };

  it('offers the lease plainly when the browser is fine', () => {
    const message = diagnoseNoSession({ ...facts, leaseBrowser: { exists: true } });
    expect(message).toContain('reticle_lease');
    expect(message).not.toContain('cannot run here');
  });

  it('still offers it, but says it cannot run, when the browser is missing', () => {
    const message = diagnoseNoSession({
      ...facts,
      leaseBrowser: { exists: false, installCommand: 'npx playwright@1.62.1 install chromium' },
    });
    expect(message).toContain('cannot run here');
    expect(message).toContain('npx playwright@1.62.1 install chromium');
  });

  it('is unchanged when the caller did not probe', () => {
    expect(diagnoseNoSession(facts)).toBe(diagnoseNoSession({ ...facts, leaseBrowser: undefined }));
  });
});
