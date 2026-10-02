/**
 * A reference to state somebody captured earlier — "get the subject into what this suite assumes".
 *
 * A suite of fifty flows that each start from cold spends most of its time proving the login works,
 * fifty times. Worse, the flow that LOGS OUT leaves every flow after it signed out, and no amount of
 * navigating fixes that: the problem is not where the subject is, it is what it holds.
 *
 * What a fixture IS cannot live in this protocol. It is a saved `storageState` on the web, a seeded
 * container on mobile, a save file at the level under test in a game, rows and a migration in a
 * service, a homed and calibrated rig in hardware. So the protocol declares THAT one exists and WHEN
 * it is applied, and the realm declares how — `applyFixture` and `captureFixture` are optional on
 * `Realm` for exactly that reason, like `locate` and `photograph`.
 *
 * A realm offering neither runs every flow from cold, which is correct and merely slower. A realm
 * that FAKES it is the failure this type is shaped to prevent: claiming a fixture you cannot restore
 * produces flows that pass because the previous flow happened to leave the right state behind, which
 * is the most expensive kind of green — it is a suite that only works in the order it was written.
 */

import { z } from 'zod';
import { SubjectRefSchema, type SubjectRef } from './subject.js';

export const FixtureRefSchema = z.object({
  /** What this state is FOR, in the words of whoever saved it — "authed-operator", "seeded-cart". */
  id: z.string().min(1),
  /**
   * The subject it was captured from, epoch included.
   *
   * Required, and it is what stops the whole idea being a footgun. State captured from a build that
   * has since been rewritten is not a shortcut: it is a green flow standing on a session the current
   * code would never have issued. Every other piece of evidence in this protocol carries an epoch
   * for the same reason, and saved state is the one that outlives the run that made it.
   */
  subject: SubjectRefSchema,
  capturedAt: z.number().int(),
  /** Opaque, realm-owned. The protocol never reads it — only the realm that wrote it can. */
  payload: z.unknown().optional(),
});
export type FixtureRef = z.infer<typeof FixtureRefSchema>;

/**
 * May this saved state still be applied to this subject?
 *
 * Same instance, same surface, same epoch. A desktop shell and a browser tab can run the same
 * application and still not share a cookie jar, so the surface is part of the identity rather than a
 * label on it.
 *
 * When NEITHER side claims an epoch the answer is yes. A realm that cannot tell when it was
 * rewritten says so by omitting the epoch, and treating that as "never reusable" would punish the
 * honest omission and push implementers to invent a number — which is the lie this check exists to
 * catch, arrived at by a different road.
 *
 * Pure: two references in, a boolean out.
 */
export function fixtureIsUsable(fixture: FixtureRef, subject: SubjectRef): boolean {
  return (
    fixture.subject.surface === subject.surface &&
    fixture.subject.instance === subject.instance &&
    fixture.subject.epoch === subject.epoch
  );
}
