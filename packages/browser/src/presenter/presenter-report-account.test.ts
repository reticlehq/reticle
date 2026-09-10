/**
 * The sign-in line must describe the state the machine is ACTUALLY in.
 *
 * Today it is gated on `dashboardUrl` alone, which is only ever set from a repo's `cloud.json`. That
 * conflates two different states: "nobody here has ever signed in" and "signed in, but this repo is
 * not linked yet". Those need opposite sentences — one is `reticle login`, the other is
 * `reticle link` — and telling a signed-in user to sign in is the kind of nag that gets a dev-only
 * HUD switched off for good.
 *
 * The third state matters as much: an older daemon sends no `account` at all. That has to read as
 * UNKNOWN and stay silent, never as "signed out". Guessing wrong there prompts a paying user to log
 * in on every panel they open.
 */

import { describe, expect, it } from 'vitest';
import { emptyImpactCounts, emptyImpactRecords, estimateImpactSavings } from '@reticlehq/core';
import type { AccountState, ImpactScope } from '@reticlehq/core';
import { reportBodyHtml } from './presenter-report.js';

const scope = (verdicts: number): ImpactScope => {
  const counts = { ...emptyImpactCounts(), calls: 10, verdicts };
  return {
    counts,
    days: [],
    records: emptyImpactRecords(),
    savings: estimateImpactSavings(counts),
    since: 0,
    defects: [],
  };
};

const html = (account?: AccountState, dashboardUrl?: string): string =>
  reportBodyHtml(scope(4), dashboardUrl, account);

describe('what the report says about signing in', () => {
  it('asks a signed-OUT user to log in', () => {
    const out = html({ signedIn: false });
    expect(out).toContain('reticle login');
  });

  it('does NOT ask a signed-in user to log in', () => {
    const out = html({ signedIn: true, org: 'Acme' });
    expect(out, 'prompting a signed-in user is the nag that gets the HUD closed').not.toContain(
      'reticle login',
    );
  });

  it('tells a signed-in user with an unlinked repo to LINK, which is the actual next step', () => {
    // The state the old gate could not express: authenticated, but this repo has no cloud.json.
    const out = html({ signedIn: true, org: 'Acme' });
    expect(out).toContain('reticle link');
  });

  it('says nothing once the repo is linked — there is no next step to offer', () => {
    const out = html({ signedIn: true, org: 'Acme' }, 'https://app.reticle.sh/p/x');
    expect(out).not.toContain('reticle login');
    expect(out).not.toContain('reticle link');
  });

  it('stays silent when the daemon sent no account state at all', () => {
    // An older daemon. Unknown is not signed-out, and must not be treated as it.
    const out = html(undefined);
    expect(out).not.toContain('reticle login');
    expect(out).not.toContain('reticle link');
  });

  it('still says nothing before a verdict has been produced', () => {
    // Unchanged rule: offering to preserve a record nobody has yet earned is an advert.
    expect(reportBodyHtml(scope(0), undefined, { signedIn: false })).not.toContain('reticle login');
  });
});
