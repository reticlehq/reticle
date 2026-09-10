/**
 * `init` waited without saying what it was waiting for.
 *
 * Reported as thirty minutes of complete silence, ending in a SIGKILL: no output, no exit, no
 * verdict. The root cause of that particular wait is still unexplained — the reporter's IPv4/IPv6
 * hypothesis does not reproduce, and the wait loop's own ceilings say a silent wait should end at
 * 45s — but the silence is a failure on its own terms, and it is the half of the title that does not
 * depend on knowing why.
 *
 * A user cannot tell "still starting" from "wedged" without being told which. Nor can they tell
 * which of the two things the loop checks is failing: the server may be up while the URL we are
 * watching is wrong, which is exactly the CRA case the loop already reasons about internally and has
 * never said out loud.
 *
 * Deliberately NOT a duration assertion. `dueAt` is compared against elapsed ms that the caller
 * supplies, so this stays a pure decision and the test never measures a real clock.
 */

import { describe, expect, it } from 'vitest';
import { waitProgressLine, WAIT_PROGRESS_EVERY_MS } from './wait-progress.js';

describe('waitProgressLine', () => {
  it('says nothing before the first interval — a fast start stays quiet', () => {
    // The common case is a server up in under a second. Announcing a wait that is not happening is
    // noise, and noise in the first command a user runs is worse than silence.
    expect(waitProgressLine(2_000, undefined, undefined)).toBeUndefined();
  });

  it('speaks once the wait is long enough to need explaining', () => {
    const line = waitProgressLine(WAIT_PROGRESS_EVERY_MS, 'http://localhost:5173', undefined);
    expect(line).toBeDefined();
    expect(String(line)).toContain('http://localhost:5173');
  });

  it('names the URL it is watching, because that is the thing most likely to be wrong', () => {
    // A dev server up on a port we are not watching looks identical to no dev server at all.
    const line = String(
      waitProgressLine(WAIT_PROGRESS_EVERY_MS, 'http://localhost:4000', undefined),
    );
    expect(line).toContain('http://localhost:4000');
    expect(line).toMatch(/watch/i);
  });

  it('says so when it has no URL yet, which is a different problem', () => {
    // No announced url and no observed port means we do not know where to look — the reader can act
    // on that (pass --url) and cannot act on "waiting".
    const line = String(waitProgressLine(WAIT_PROGRESS_EVERY_MS, undefined, undefined));
    expect(line).toMatch(/no url|not announced|--url/i);
  });

  it('repeats on each interval, not on every poll', () => {
    // The loop polls continuously; a line per poll would bury the output it is meant to explain.
    expect(
      waitProgressLine(WAIT_PROGRESS_EVERY_MS * 2, 'http://x', WAIT_PROGRESS_EVERY_MS),
    ).toBeDefined();
    expect(
      waitProgressLine(WAIT_PROGRESS_EVERY_MS + 1, 'http://x', WAIT_PROGRESS_EVERY_MS),
    ).toBeUndefined();
  });

  it('reports how long it has been waiting, in whole seconds', () => {
    const line = String(waitProgressLine(90_000, 'http://x', undefined));
    expect(line).toContain('90s');
  });
});
