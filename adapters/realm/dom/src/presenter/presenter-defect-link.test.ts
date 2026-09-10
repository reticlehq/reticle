/**
 * Each defect row offers a way through to the dashboard, and says what that is FOR.
 *
 * The first design put a GitHub mark on the row. That would have been a lie about the destination:
 * a GitHub mark promises "this files a GitHub issue", and the link goes to the Reticle dashboard.
 * Pushing to GitHub is something the dashboard manages, so the honest icon is the dashboard's and
 * the sentence has to carry the rest — the user learns what they get by going there rather than
 * discovering the icon did something else.
 *
 * Gated on a linked project. An icon that leads somewhere the user has no account for is an advert
 * on a row about their own broken app, which is the worst possible moment for one.
 */

import { describe, expect, it } from 'vitest';
import { emptyImpactCounts, emptyImpactRecords, estimateImpactSavings } from '@reticlehq/core';
import type { ImpactDefect, ImpactScope } from '@reticlehq/core';
import { reportBodyHtml } from './presenter-report.js';
import { REPORT_TEXT } from './chrome/presenter-report-copy.js';

const DEFECT: ImpactDefect = {
  title: 'Sign in did not navigate',
  at: 0,
  detail: 'route stayed /login',
  source: 'src/Login.tsx:81',
};

const scope = (defects: ImpactDefect[]): ImpactScope => {
  const counts = { ...emptyImpactCounts(), calls: 10, verdicts: 4, failed: defects.length };
  return {
    counts,
    days: [],
    records: emptyImpactRecords(),
    savings: estimateImpactSavings(counts),
    since: 0,
    defects,
  };
};

const LINKED = 'https://app.reticle.sh/p/acme';

describe('the way through from a defect row', () => {
  it('gives a linked project a link on the row itself', () => {
    const html = reportBodyHtml(scope([DEFECT]), LINKED, { signedIn: true });
    expect(html).toContain(LINKED);
    expect(html).toContain('reticle-report-defect-link');
  });

  it('opens in a new tab, safely — the HUD sits inside somebody else’s app', () => {
    const html = reportBodyHtml(scope([DEFECT]), LINKED, { signedIn: true });
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
  });

  it('carries no github MARK, though the copy may name github', () => {
    // The distinction is the whole design. Saying "push to GitHub" is the point — that is what the
    // dashboard is for and the user should know it. Drawing GitHub's logo on a link that goes to our
    // dashboard is a promise about the destination that the click does not keep.
    const html = reportBodyHtml(scope([DEFECT]), LINKED, { signedIn: true });
    const anchor = html.match(/<a class="reticle-report-defect-link"[\s\S]*?<\/a>/)?.[0] ?? '';
    expect(anchor, 'the row link must render at all').not.toBe('');
    const svg = anchor.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? '';
    expect(svg.toLowerCase(), 'the ICON is the dashboard’s, not GitHub’s').not.toContain('github');
    expect(html.toLowerCase(), 'the COPY should say what the dashboard gives you').toContain(
      'github',
    );
  });

  it('says what the dashboard is for, including pushing to a tracker', () => {
    // The sentence carries what the icon cannot. Without it the link is just an exit.
    expect(REPORT_TEXT.DEFECTS_MORE.toLowerCase()).toMatch(/dashboard/);
    expect(REPORT_TEXT.DEFECT_LINK_TITLE.toLowerCase()).toMatch(/dashboard|github|track/);
  });

  it('offers no row link when the project is not linked', () => {
    // An icon leading somewhere the user has no account for is an advert on a row about their own
    // broken app.
    const html = reportBodyHtml(scope([DEFECT]), undefined, { signedIn: false });
    expect(html).not.toContain('reticle-report-defect-link');
  });

  it('refuses a dashboard url that is not http(s)', () => {
    const html = reportBodyHtml(scope([DEFECT]), 'javascript:alert(1)', { signedIn: true });
    expect(html).not.toContain('reticle-report-defect-link');
    expect(html).not.toContain('javascript:');
  });

  it('escapes the url it renders', () => {
    const html = reportBodyHtml(scope([DEFECT]), 'https://x.test/"><img src=x>', {
      signedIn: true,
    });
    expect(html).not.toContain('"><img src=x>');
  });
});
