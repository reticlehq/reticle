/**
 * A drift reason that prints the same name twice and calls them different.
 *
 * Reported from the field, verbatim:
 *
 * > The drift message is self-contradictory and cost real debugging time:
 * > `role anchor button "Add User" not found; the closest surviving button is "Add User"`.
 *
 * Read literally it says the control both is and is not there. What it actually means is subtler and
 * far more useful: the anchor's stored name and the live accessible name are the SAME STRING, so
 * this is not a rename — the query matched nothing for some other reason. In the reported case the
 * recorded name came from a `placeholder` (`reticle_query` reports `name:"Search User"` for
 * `<input type="search" placeholder="Search User">`), and the replay resolver computes accessible
 * names differently, so the round trip cannot close.
 *
 * An agent told "the name changed" edits the wrong thing. An agent told "the names are identical, so
 * this is not a rename" stops guessing. `flow_heal` correctly refuses either way, which is what
 * makes the message the only thing the reader has.
 */

import { describe, expect, it } from 'vitest';
import { roleDriftReason } from './role-drift-reason.js';

describe('roleDriftReason', () => {
  it('says plainly that a rename is NOT what happened when the names are identical', () => {
    const reason = roleDriftReason('button', 'Add User', 'Add User');
    expect(reason).not.toMatch(/the closest surviving button is "Add User"/);
    expect(reason, 'the reader must be told the names match').toMatch(/identical|same name/i);
    expect(reason, 'and that a rename is therefore ruled out').toMatch(
      /not a rename|did not change/i,
    );
  });

  it('still reports a genuine rename as one', () => {
    const reason = roleDriftReason('button', 'Add User', 'Create User');
    expect(reason).toContain('Add User');
    expect(reason).toContain('Create User');
    expect(reason, 'a real rename must not be described as a matching name').not.toMatch(
      /identical/i,
    );
  });

  it('handles no candidate at all without inventing one', () => {
    const reason = roleDriftReason('button', 'Add User', null);
    expect(reason).toContain('Add User');
    expect(reason).toMatch(/no surviving button/i);
  });

  it('treats a case- or whitespace-only difference as identical, because it is to a reader', () => {
    expect(roleDriftReason('button', 'Add User', '  add user ')).toMatch(/identical|same name/i);
  });
});
