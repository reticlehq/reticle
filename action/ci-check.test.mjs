import { describe, expect, it } from 'vitest';
import {
  checkPayload,
  decide,
  flowFileName,
  prNumber,
  readResults,
  suiteFlows,
} from './ci-check.mjs';

describe('the check the action posts', () => {
  it('carries the repo, commit, ref, url and every journey, plus the PR number on a pull request', () => {
    const payload = checkPayload({
      env: { GITHUB_REPOSITORY: 'acme/shop', GITHUB_SHA: 'abc', GITHUB_REF: 'refs/pull/7/merge' },
      url: 'https://preview.example',
      results: [{ journey: 'checkout', verdict: 'yes' }],
      event: { pull_request: { number: 7 } },
    });
    expect(payload).toEqual({
      repo: 'acme/shop',
      sha: 'abc',
      pr: 7,
      ref: 'refs/pull/7/merge',
      url: 'https://preview.example',
      results: [{ journey: 'checkout', verdict: 'yes' }],
    });
  });

  it('leaves the PR out on a push', () => {
    expect(prNumber({})).toBeUndefined();
    expect(checkPayload({ env: {}, url: 'u', results: [], event: {} })).not.toHaveProperty('pr');
  });
});

describe('how the job ends', () => {
  it('fails on a no, and prints where the details are', () => {
    expect(
      decide({ status: 200, body: { verdict: 'no', detailsUrl: 'https://d' }, resultCount: 2 }),
    ).toEqual({ code: 1, lines: ['Reticle verdict: no', 'Details: https://d'] });
  });

  it('fails on a trial that needs a card, with the platform message', () => {
    expect(
      decide({
        status: 402,
        body: { error: 'needs_card', message: 'Your trial has ended.' },
        resultCount: 2,
      }),
    ).toEqual({ code: 1, lines: ['Your trial has ended.'] });
  });

  it('passes on a yes', () => {
    expect(decide({ status: 200, body: { verdict: 'yes' }, resultCount: 1 }).code).toBe(0);
  });

  it('never passes a run that verified nothing', () => {
    expect(decide({ status: 200, body: { verdict: 'unknown' }, resultCount: 0 }).code).toBe(1);
  });

  it('fails when the platform refused the check', () => {
    expect(decide({ status: 401, body: { error: 'unauthorized' }, resultCount: 1 }).code).toBe(1);
  });
});

describe('what verify and the suite hand over', () => {
  it('reads the per-journey verdicts, and none from a file that is not the shape', () => {
    expect(readResults('{"verdict":"yes","results":[{"journey":"a","verdict":"yes"}]}')).toEqual([
      { journey: 'a', verdict: 'yes' },
    ]);
    expect(readResults('not json')).toEqual([]);
  });

  it('takes the suite as an array or under flows, and keeps only named flows', () => {
    expect(suiteFlows([{ name: 'a' }, {}])).toEqual([{ name: 'a' }]);
    expect(suiteFlows({ flows: [{ name: 'b' }] })).toEqual([{ name: 'b' }]);
    expect(suiteFlows(null)).toEqual([]);
  });

  it('never lets a flow name write outside the flows directory', () => {
    expect(flowFileName('../../etc/passwd')).toBe('-etc-passwd.json');
    expect(flowFileName('checkout')).toBe('checkout.json');
  });
});
