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
import { driveRunFrom, driveRunId } from './drive-run.js';
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
    it('writes NO run when every verdict was undetermined', () => {
      // A run with zero checks computes to PASS. A green row meaning "nothing was measured" is worse
      // than no row: it is exactly the false green the whole product exists to prevent.
      expect(
        driveRunFrom([action(Verified.UNKNOWN), action(Verified.NO_FAULT)], DEPS),
      ).toBeUndefined();
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

/**
 * One row per drive, not one per page reload.
 *
 * Session teardown fires on every socket close, and a reconnecting tab keeps its session id and goes
 * on appending to the same journal. A random run id per teardown would publish a row per reload,
 * each a superset of the last, and one drive would look like five overlapping verifications.
 */
describe('the run id for a drive', () => {
  it('is derived from the session, so a re-fold rewrites the same row', () => {
    const id = 'scc5398dc-8e92-4733-bbdd-1787041cb69d';
    expect(driveRunId(id)).toBe(driveRunId(id));
    expect(driveRunId(id)).toContain(id);
  });

  it('separates two sessions, which are two drives', () => {
    expect(driveRunId('s-one')).not.toBe(driveRunId('s-two'));
  });

  it('marks it as a drive, so it cannot collide with a replay run', () => {
    expect(driveRunId('s-one').startsWith('drive-')).toBe(true);
  });

  it('falls back to a random id for a session id that is not a safe path segment', () => {
    // A session id is a free string on the wire. Losing idempotence for one session is the right
    // concession; letting `../` reach a file path is not.
    const unsafe = '../../etc/passwd';
    expect(driveRunId(unsafe)).not.toContain('..');
    expect(driveRunId(unsafe)).not.toBe(driveRunId(unsafe));
  });
});
