/**
 * What to say when a role+name anchor no longer resolves.
 *
 * The old message could contradict itself in the one case that matters most:
 *
 *   role anchor button "Add User" not found; the closest surviving button is "Add User"
 *
 * Read literally that says the control both is and is not there, and it cost a reporter real
 * debugging time. What it means is more useful than a rename: the stored name and the live
 * accessible name are the SAME STRING, so the name is not what changed — the query matched nothing
 * for some other reason.
 *
 * In the reported case the recorded name came from a `placeholder` — `reticle_query` reports
 * `name:"Search User"` for `<input type="search" placeholder="Search User">` with no label — and the
 * replay resolver computes accessible names differently, so the round trip cannot close. That is a
 * real bug in its own right (two accessible-name implementations disagreeing), and while it is open
 * the message is the only thing the reader has, because `flow_heal` correctly refuses to rebind a
 * role anchor on its own.
 */

/** Same name to a reader: case and surrounding whitespace are not a rename. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function roleDriftReason(role: string, name: string, nearest: string | null): string {
  const label = `${role} "${name}"`;
  if (null === nearest) {
    return (
      `role anchor ${label} not found, and no surviving ${role} has a similar name — ` +
      'anchor this step to a data-testid'
    );
  }
  if (sameName(name, nearest)) {
    // The one case the old wording made unreadable. Say what is ruled OUT — that is the information.
    return (
      `role anchor ${label} did not resolve, but a ${role} with an identical name is on the page — ` +
      'so this is NOT a rename and editing the label will not fix it. The recorded name and the ' +
      'name the resolver computes disagree, which happens when the recorded one came from a ' +
      'placeholder or title rather than a label or aria-label. Anchor this step to a data-testid.'
    );
  }
  return (
    `role anchor ${label} not found; the closest surviving ${role} is "${nearest}" — ` +
    'confirm it is the same control before rebinding, or add a data-testid'
  );
}
