import { describe, it, expect } from 'vitest';
import { getAccessibleName, getRole } from './a11y.js';
import { matchQuery } from './query.js';

/**
 * The name Reticle PRINTS must be a name Reticle can MATCH.
 *
 * The matcher and reporter must use one accessibility engine. `getAccessibleName` is what
 * `reticle_query`, `reticle_snapshot` and every act result report, and it falls back to
 * `placeholder` and then `title`. The resolver now filters with the same local `getRole` and
 * `getAccessibleName`, so a reported identity can round-trip without a second implementation
 * disagreeing underneath it.
 *
 * Reported as a recorder bug: the flow recorder anchors a step to the reported name, `flow_save`
 * grades it `asserted` with `degraded: 0` — a clean bill of health — and the step drifts on the
 * first replay, in a different session. The reporter diagnosed it as the replay resolver computing
 * names differently. It is narrower and worse than that: the SAME query call reports a name it
 * cannot match, so the round trip could never close for any caller.
 *
 * Fixed by making Reticle's own reported role and name the source of truth, rather than by dropping
 * placeholder from the reported name. An input whose only label is its placeholder would otherwise
 * go nameless in every snapshot, which is a readability regression for the common case.
 */
describe('accessible-name round trip', () => {
  it('a placeholder-named input is findable by the name Reticle reports for it', () => {
    document.body.innerHTML = '<input type="search" placeholder="Search User" />';
    const el = document.querySelector('input') as HTMLInputElement;
    const role = getRole(el);
    const name = getAccessibleName(el);
    expect({ role, name }).toEqual({ role: 'textbox', name: 'Search User' });
    expect(matchQuery({ role, name }).matched, 'reported, therefore matchable').toBe(true);
  });

  it('a title-named control is findable too — same fallback chain, same promise', () => {
    document.body.innerHTML = '<div role="button" title="Dismiss"></div>';
    const el = document.querySelector('div') as HTMLElement;
    expect(getAccessibleName(el)).toBe('Dismiss');
    expect(matchQuery({ role: 'button', name: 'Dismiss' }).matched).toBe(true);
  });

  it('still does not match a name no element has', () => {
    // The control that matters: a fallback that matches anything would turn every drift green.
    document.body.innerHTML = '<input type="search" placeholder="Search User" />';
    expect(matchQuery({ role: 'textbox', name: 'Search Orders' }).matched).toBe(false);
  });

  it('still does not match the right name on the wrong role', () => {
    document.body.innerHTML = '<input type="search" placeholder="Search User" />';
    expect(matchQuery({ role: 'button', name: 'Search User' }).matched).toBe(false);
  });

  it('uses the role Reticle reports, not a second library role', () => {
    document.body.innerHTML = '<input type="search" placeholder="Search User" />';
    expect(matchQuery({ role: 'textbox', name: 'Search User' }).matched).toBe(true);
    expect(matchQuery({ role: 'searchbox', name: 'Search User' }).matched).toBe(false);
  });

  it('the ordinary label path is unchanged', () => {
    document.body.innerHTML = '<label>Email <input /></label>';
    expect(matchQuery({ role: 'textbox', name: 'Email' }).matched).toBe(true);
  });
});
