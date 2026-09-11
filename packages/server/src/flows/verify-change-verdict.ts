/**
 * What a replayed suite's status entitles `verify_change` to claim.
 *
 * This was `suite.status !== 'pass'` meaning failure. That was true while the only statuses were
 * pass and fail — but `flow_verify` now reports `unverifiable` for a suite that ran and proved
 * nothing (an empty suite used to report `pass`, which was a false green). Under the old test,
 * `unverifiable` fell into the failure branch: a suite that proved nothing came back as proof the
 * change was broken, and emitted a `bug_found` for it.
 *
 * `unverifiable` is the same fact this tool already handles elsewhere as "no saved flow covers this
 * change" — answered UNKNOWN, with the comment calling it "the honest answer, never a green: nothing
 * ran, so nothing was proved". A red nothing earned is the mirror image of that green.
 */
import { Verified } from '@reticlehq/core';

const PASS = 'pass';
const FAIL = 'fail';

export function verdictForSuite(status: string, failedCount: number): Verified {
  // A real failure outranks everything: flows ran and some went red.
  if (failedCount > 0 || status === FAIL) return Verified.NO;
  if (status === PASS) return Verified.YES;
  // `unverifiable`, or any status added later. Nothing was proved, so nothing is claimed.
  return Verified.UNKNOWN;
}
