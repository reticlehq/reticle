import { describe, expect, it } from 'vitest';
import { findingBeforeOpen, PageFinding, type PageProbe } from './probe/page-probe.js';

/**
 * The decision that cost a supported framework its install.
 *
 * `init` opens a browser because the browser is what loads the bundle that dials the daemon. It
 * refuses when the url answers nothing, which is right: a window onto a dead url shows an error
 * page. The refusal used to be taken on the FIRST probe, because the wait retried on
 * `SDK_MISSING` and not on `NOT_SERVED`.
 *
 * A dev server that has not finished starting looks exactly like a url that will never answer,
 * at the first probe and only at the first probe. The install gate's Nuxt scaffold printed
 * "nothing is serving" and "Not opening a browser", then two lines later "is served". No
 * window, no bundle, no session, `init` exited 1 on a correct install.
 *
 * These drive the decision directly. Going through `runSetupPhases` cannot reach it: the
 * dev-server wait calls the same `probePage` about 1,500 times first, so a fixture that counts
 * calls is exhausted long before the moment under test. Two tests written that way passed
 * against the broken code and were deleted.
 */

/** A clock that runs out after a fixed number of looks, so a test cannot hang. */
function clockOf(ticks: number): { now: () => number; sleep: () => Promise<void> } {
  let t = 0;
  return {
    now: () => {
      t += 1;
      return t > ticks ? 1_000_000 : 0;
    },
    sleep: () => Promise.resolve(),
  };
}

/** Answers in order, then repeats the last one forever. */
const probeOf = (first: PageProbe, ...rest: PageProbe[]): (() => Promise<PageProbe>) => {
  const answers = [first, ...rest];
  let i = 0;
  return () => {
    const next = answers[Math.min(i, answers.length - 1)] ?? first;
    i += 1;
    return Promise.resolve(next);
  };
};

const NOT_UP: PageProbe = { served: false, sdkInPage: false };
const UP_NO_SDK: PageProbe = { served: true, sdkInPage: false };
const UP_WITH_SDK: PageProbe = { served: true, sdkInPage: true };

describe('waiting for a page before deciding to open a window', () => {
  it('waits out a dev server that is not up YET, and reports what it became', async () => {
    // The regression, in one line: two probes of "not up" then the server answers.
    const finding = await findingBeforeOpen(probeOf(NOT_UP, NOT_UP, UP_NO_SDK), clockOf(20), 5, 1);
    expect(finding).toBe(PageFinding.SDK_MISSING);
  });

  it('still reports NOT_SERVED for a url that never answers', async () => {
    // The control. Waiting forever, or opening regardless, would be worse than the bug: a
    // window onto a dead url is an error page, and the refusal exists for that.
    expect(await findingBeforeOpen(probeOf(NOT_UP), clockOf(4), 5, 1)).toBe(PageFinding.NOT_SERVED);
  });

  it('returns at once when the SDK is already there, without spending the window', async () => {
    let calls = 0;
    const probe = (): Promise<PageProbe> => {
      calls += 1;
      return Promise.resolve(UP_WITH_SDK);
    };
    expect(await findingBeforeOpen(probe, clockOf(20), 5, 1)).toBe(PageFinding.SDK_PRESENT);
    expect(calls, 'a page that is ready should be asked once').toBe(1);
  });

  it('waits for a bundle-delivered SDK too, which is what it already did', async () => {
    // Unchanged behaviour, pinned so the fix above cannot be mistaken for a rewrite.
    expect(
      await findingBeforeOpen(probeOf(UP_NO_SDK, UP_NO_SDK, UP_WITH_SDK), clockOf(20), 5, 1),
    ).toBe(PageFinding.SDK_PRESENT);
  });
});
