/**
 * The `--report` page: one HTML file a person opens to see what changed between two builds. Its text comes from the
 * pages under test, so every value is escaped: a page that shows `<script>` must not run it inside the report.
 */
import { describe, expect, it } from 'vitest';
import { CompareVerdict, invalidComparison } from './behaviour-diff.js';
import type { BehaviourComparison } from './behaviour-diff.js';
import { DifferenceKind } from './compare-diff.js';
import { compareReportJson } from './behaviour-report.js';
import { compareReportHtml } from './compare-report-html.js';

const urls = { reference: 'http://ref.test/', candidate: 'http://cand.test/' };

const different: BehaviourComparison = {
  verdict: CompareVerdict.DIFFERENT,
  sequences: 12,
  compared: 10,
  unstable: 1,
  referenceFailed: 1,
  ignored: 3,
  differences: [
    {
      id: 'd1',
      kind: DifferenceKind.CHANGED,
      actions: ['open the start page', 'click button "Save"'],
      removed: ['status "Saved"'],
      added: ['alert "Email is not valid."'],
      seen: 2,
    },
    {
      id: 'd2',
      kind: DifferenceKind.UNREACHED,
      actions: ['click link "Favorites"'],
      removed: [],
      added: [],
      failedAt: 'click link "Favorites"',
      seen: 1,
    },
  ],
};

describe('compareReportHtml', () => {
  it('is one self-contained page: no external script, style or font', () => {
    const html = compareReportHtml(compareReportJson(urls, different));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b[^>]*href=/i);
    expect(html).not.toMatch(/src=["']https?:/i);
  });

  it('shows the verdict, both urls and the counts that qualify it', () => {
    const html = compareReportHtml(compareReportJson(urls, different));
    expect(html).toContain('DIFFERENT');
    expect(html).toContain('http://ref.test/');
    expect(html).toContain('http://cand.test/');
    expect(html).toMatch(/10<\/b> of 12/);
    expect(html).toMatch(/3<\/b> lines ignored/);
  });

  it('lists each difference with the steps that reached it and the lines on each side', () => {
    const html = compareReportHtml(compareReportJson(urls, different));
    expect(html).toContain('click button &quot;Save&quot;');
    expect(html).toContain('status &quot;Saved&quot;');
    expect(html).toContain('alert &quot;Email is not valid.&quot;');
    expect(html).toContain('Seen in 2 sequences');
    expect(html).toContain('The candidate could not do this step');
  });

  it('escapes text from the pages under test, so a page cannot run code in the report', () => {
    const [first] = different.differences;
    if (first === undefined) {
      throw new Error('fixture has a difference');
    }
    const hostile: BehaviourComparison = {
      ...different,
      differences: [
        { ...first, added: ['<img src=x onerror=alert(1)>', '</pre><script>x()</script>'] },
      ],
    };
    const html = compareReportHtml(compareReportJson(urls, hostile));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/<script>x\(\)/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('says why an invalid run proves nothing, and lists no differences', () => {
    const html = compareReportHtml(
      compareReportJson(urls, invalidComparison('The reference url did not open.', 0)),
    );
    expect(html).toContain('INVALID');
    expect(html).toContain('The reference url did not open.');
    expect(html).toContain('nothing was proved');
  });

  it('says plainly when the builds behave the same', () => {
    const same: BehaviourComparison = {
      ...different,
      verdict: CompareVerdict.SAME,
      differences: [],
    };
    const html = compareReportHtml(compareReportJson(urls, same));
    expect(html).toContain('SAME');
    expect(html).toContain('No difference in what users see');
  });
});
