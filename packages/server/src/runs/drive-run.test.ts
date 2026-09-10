/**
 * The dashboard was empty because nothing wrote a run, and driving the app is the product.
 *
 * From a field session: 89 `reticle_act_and_wait` and 15 `reticle_assert` calls, `lastPushAt: null`
 * throughout, no rows on the platform. `diskSource.runs()` reads `.reticle/runs/`, and the only
 * writer was flow replay — so a live drive, which is how every user meets Reticle, produced no
 * artifact and therefore synced nothing.
 */
import { describe, expect, it } from 'vitest';
import { RunCheckStatus, Verified, type JournalAction } from '@reticlehq/core';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';
import { driveRunFrom } from './drive-run.js';
import { computeVerdict } from './build-verification-run.js';
import { VerdictStatus } from '@reticlehq/core';

let seq = 0;
const action = (
  verified: Verified | undefined,
  claim = 'the row disappears',
  at = ++seq,
): JournalAction => ({
  v: 1,
  actionId: `c${String(at)}`,
  tool: 'reticle_act_and_wait',
  args: {},
  ...(verified === undefined ? {} : { effect: { claim, verified } }),
  tRange: { from: 0, to: at },
  at,
});

const DEPS = { runId: 'run_1', projectId: 'acme-web-1234abcd' };

describe('a drive folded into a run', () => {
  it('turns a proved verdict into a passing check', () => {
    const run = driveRunFrom([action(Verified.YES, 'the row disappears')], DEPS);
    expect(run?.checks).toHaveLength(1);
    expect(run?.checks[0]?.status).toBe(RunCheckStatus.PASS);
    expect(run?.checks[0]?.predicate).toBe('the row disappears');
  });

  it('turns a disproved verdict into a failing check, and the run verdict follows', () => {
    const run = driveRunFrom([action(Verified.NO)], DEPS);
    expect(run?.checks[0]?.status).toBe(RunCheckStatus.FAIL);
    expect(run === undefined ? undefined : computeVerdict(run).status).toBe(VerdictStatus.FAIL);
  });

  it('ignores actions that recorded no verdict at all — an act proves nothing', () => {
    expect(driveRunFrom([action(undefined), action(Verified.YES)], DEPS)?.checks).toHaveLength(1);
  });

  /**
   * The false-green guard, and the reason this fold is not a one-liner. `RunCheckStatus` is binary;
   * `Verified` is not. `unknown` means "I could not tell" and `no-fault` means "nothing was declared
   * to prove", and the product reports both as NOT PROVED.
   */
  describe('verdicts that proved nothing', () => {
    it('writes a run that says nothing was proved, rather than staying silent', () => {
      // This was written the other way round, and for a reason that was true then: a run with zero
      // checks computed to PASS, so writing one would have put a green row meaning "nothing was
      // measured" on a dashboard -- the exact false green the product exists to prevent. Staying
      // silent was the only honest option available.
      //
      // A zero-check run now computes to UNKNOWN, so the honest option is available, and it is the
      // better one. A drive that produced verdicts and resolved none of them is precisely what
      // somebody needs to see: their verification is not working. Silence hides that behind an empty
      // dashboard that looks the same as never having driven at all.
      const run = driveRunFrom([action(Verified.UNKNOWN), action(Verified.NO_FAULT)], DEPS);
      expect(run?.checks).toHaveLength(0);
      // And it must read UNKNOWN, not PASS. If that ever changes back, this row becomes the false
      // green the original refusal existed to avoid, and the refusal is no longer there to stop it.
      expect(buildVerificationRun(run as VerificationRunInput, () => 1).verdict.status).toBe(
        VerdictStatus.UNKNOWN,
      );
    });

    it('never counts one as a pass when there were real verdicts alongside it', () => {
      const run = driveRunFrom([action(Verified.YES), action(Verified.UNKNOWN)], DEPS);
      expect(run?.checks).toHaveLength(1);
      expect(run === undefined ? undefined : computeVerdict(run).status).toBe(VerdictStatus.PASS);
    });

    it('says how many it dropped, so the row is not silently lossy', () => {
      const run = driveRunFrom(
        [action(Verified.YES), action(Verified.UNKNOWN), action(Verified.NO_FAULT)],
        DEPS,
      );
      expect(run?.trigger.note).toContain('2 further verdict(s) were undetermined');
    });

    it('says nothing about them when there were none', () => {
      expect(driveRunFrom([action(Verified.YES)], DEPS)?.trigger.note).not.toContain(
        'undetermined',
      );
    });
  });

  it('produces nothing at all for a session that never verified anything', () => {
    expect(driveRunFrom([], DEPS)).toBeUndefined();
  });

  it('takes its duration from the journal clock, not from wall time', () => {
    const run = driveRunFrom([action(Verified.YES, 'a', 10), action(Verified.NO, 'b', 250)], DEPS);
    expect(run?.durationMs).toBe(250);
  });

  it('carries the project through, or the dashboard row belongs to nobody', () => {
    expect(driveRunFrom([action(Verified.YES)], DEPS)?.project.name).toBe('acme-web-1234abcd');
  });

  it('keeps the source pointer as evidence when the page gave one', () => {
    const withSource: JournalAction = {
      ...action(Verified.YES),
      effect: { claim: 'saved', verified: Verified.YES, source: 'src/Form.tsx:42:8' },
    };
    expect(driveRunFrom([withSource], DEPS)?.checks[0]?.evidence).toEqual({
      source: 'src/Form.tsx:42:8',
    });
  });
});
