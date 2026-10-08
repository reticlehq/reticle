/**
 * What a leased tab that did not connect should say.
 *
 * `reticle_lease` is the highest-value path in the whole product and nobody knows it. A leased
 * session is driven many times harder than an unleased one and is where most of the bugs anybody
 * finds get found; sessions that bounce after a single call never used a lease. It works because
 * it does not wait for the human's tab to dial in — Reticle opens its own.
 *
 * And the plan file listed it as UNVERIFIED, "one acquire returned ready:false", possibly broken.
 * Driven for real it is not broken at all: against a daemon on the port the app was built to dial,
 * `acquire` returns ready:true and the session is immediately driveable. The failing case was a
 * PORT MISMATCH — the leased tab loads the app, and the app's SDK dials whatever port it was built
 * with, which is not necessarily the daemon that issued the lease. (Proof: the tab from the failed
 * cross-port acquire later showed up as a live session on the OTHER daemon.)
 *
 * The hint claimed the opposite: "is <url> running with @reticlehq/core enabled?" — when the app was
 * running, was instrumented, and had already connected somewhere else. Same defect as the old
 * no-session message: it names the one thing that is definitely true and sends the reader away from
 * the cause.
 */

import { describe, expect, it } from 'vitest';
import { leaseNotConnectedHint } from './lease-hint.js';

describe('leaseNotConnectedHint', () => {
  const hint = leaseNotConnectedHint('http://localhost:5173/', 4400);

  it('names the port THIS daemon is on — the other half of the mismatch', () => {
    expect(hint).toContain('4400');
  });

  it('names the url that was opened', () => {
    expect(hint).toContain('http://localhost:5173/');
  });

  it('leads with the mismatch, not with "is your app running"', () => {
    expect(hint).toMatch(/port|different daemon/i);
    // The tab demonstrably loaded — Playwright navigated it — so this question is always answered.
    expect(hint).not.toMatch(/is .* running with/i);
  });

  it('still allows for the app simply not being instrumented, as the SECOND possibility', () => {
    expect(hint).toMatch(/reticle init|SDK/i);
  });

  it('gives the agent something to do', () => {
    expect(hint).toMatch(/check|run |restart|match/i);
  });
});

/**
 * The one cause the hint could never name, because it was the one thing it never asked about.
 *
 * A leased page that dials a DIFFERENT port than the daemon it was leased by produces no refusal
 * here — the dial never arrives, so `lastClosure()` is silent and every ranked branch falls through
 * to a differential that lists the port mismatch last, or not at all. Driven on the bench fixture:
 * the app dialled 4460, the daemon was on 4400, and the hint answered with four causes, all of which
 * presuppose the port is right. It cost a quarter of an hour to find by hand.
 *
 * The page already knows. Its own unreachable warning names the URL it tried, and the pool owns that
 * browser — so the daemon can read the address off the page's console and compare it with the port
 * it is bound to. Neither half can diagnose this alone: the page cannot tell an absent daemon from
 * an unreachable one, and the daemon cannot see a dial that never arrived.
 */
describe('a page that dialled somewhere else', () => {
  it('names both ports instead of listing causes that assume the port is right', () => {
    const hint = leaseNotConnectedHint('http://localhost:4312/', 4400, {
      dialledUrl: 'ws://localhost:4460/reticle',
      previouslyConnected: true,
      initialized: true,
      sdkMarker: true,
    });
    expect(hint).toContain('4460');
    expect(hint).toContain('4400');
  });

  it('outranks every inferred cause, because it is the only one with proof', () => {
    const hint = leaseNotConnectedHint('http://localhost:4312/', 4400, {
      dialledUrl: 'ws://localhost:4460/reticle',
      previouslyConnected: true,
      initialized: true,
    });
    // The four-cause differential presupposes the dial reached this daemon. It did not.
    expect(hint).not.toContain('dev-mode guard');
  });

  it('says nothing when the page dialled this very daemon — then the port is exonerated', () => {
    const hint = leaseNotConnectedHint('http://localhost:4312/', 4400, {
      dialledUrl: 'ws://localhost:4400/reticle',
      initialized: true,
    });
    expect(hint).not.toMatch(/dialled a different|different port/i);
  });
});

/*
 * Driven: an uninstrumented page served with `Content-Security-Policy: connect-src 'self'` was
 * leased, zero-install supplied the SDK, and the policy stopped its socket. The same page without
 * the header connected. The hint said "run `reticle init`" and listed four causes, none of them the
 * policy it could have read off the page.
 */
describe('a page whose CSP blocks the bridge', () => {
  const cspBlock = {
    problem: "connect-src 'self' does not allow ws://localhost:4400",
    fix: 'add ws://localhost:4400 to connect-src in development',
  };

  it('names the policy and the fix, and says init cannot help', () => {
    const hint = leaseNotConnectedHint('http://localhost:4455/', 4400, {
      cspBlock,
      sdkMarker: false,
    });
    expect(hint).toContain('Content-Security-Policy');
    expect(hint).toContain(cspBlock.fix);
    expect(hint).not.toContain('run `reticle init`');
  });

  it('outranks the guessed causes, but not a page that dialled the wrong port', () => {
    const wrongPort = leaseNotConnectedHint('http://localhost:4455/', 4400, {
      cspBlock,
      dialledUrl: 'ws://localhost:4999/reticle',
    });
    expect(wrongPort).toContain('4999');
  });
});

describe('a production build whose SDK was stubbed', () => {
  it('points an initialized project at the dev server, not back at init', () => {
    const hint = leaseNotConnectedHint('http://localhost:4173/', 4400, {
      initialized: true,
      sdkMarker: false,
    });
    expect(hint).toMatch(/production build/i);
    expect(hint).toMatch(/stub|strip/i);
    expect(hint).toMatch(/dev server/i);
    expect(hint).not.toContain('reticle init');
  });

  it('treats a non-localhost URL as likely production even without a marker check', () => {
    const hint = leaseNotConnectedHint('https://app.example.com/', 4400);
    expect(hint).toMatch(/production build/i);
    expect(hint).toMatch(/dev server/i);
  });

  // Nothing says this project was ever wired, so a missing marker is first of all a missing
  // install: the production note may join the init advice, never replace it.
  it('keeps the init advice for an unwired project whose page carried no marker', () => {
    const hint = leaseNotConnectedHint('http://localhost:4173/', 4400, { sdkMarker: false });
    expect(hint).toContain('reticle init');
    expect(hint).toMatch(/production build/i);
  });

  it('never names a production stub beside an SDK marker that WAS found', () => {
    for (const evidence of [
      { previouslyConnected: true, sdkMarker: true },
      { initialized: true, sdkMarker: true },
      { sdkMarker: true },
    ]) {
      const hint = leaseNotConnectedHint('https://app.example.com/', 4400, evidence);
      expect(hint).toMatch(/marker WAS found/);
      expect(hint).not.toMatch(/production build/i);
    }
  });

  it('does not treat every loopback address as production', () => {
    const hint = leaseNotConnectedHint('http://127.0.0.2:5173/', 4400);
    expect(hint).not.toMatch(/production build/i);
  });

  it('keeps production as an extra possibility when another app may have connected before', () => {
    const hint = leaseNotConnectedHint('http://localhost:4173/', 4400, {
      initialized: true,
      previouslyConnected: true,
      sdkMarker: false,
    });
    expect(hint).toMatch(/DIFFERENT app/i);
    expect(hint).toMatch(/reticle init/i);
    expect(hint).toMatch(/production build/i);
  });

  it('does not attach the production explanation to a refused dial', () => {
    const hint = leaseNotConnectedHint('http://localhost:4173/', 4400, {
      refusal: 'wrong pairing token',
      sdkMarker: false,
    });
    expect(hint).toContain('wrong pairing token');
    expect(hint).not.toMatch(/production build/i);
  });

  it('does not attach the production explanation to a proven port mismatch', () => {
    const hint = leaseNotConnectedHint('http://localhost:4173/', 4400, {
      dialledUrl: 'ws://localhost:4444/reticle',
      sdkMarker: false,
    });
    expect(hint).toContain('4444');
    expect(hint).not.toMatch(/production build/i);
  });
});
