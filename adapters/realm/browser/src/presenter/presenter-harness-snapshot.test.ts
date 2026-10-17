/**
 * The Harness page reads its run from the daemon's snapshot (matrix drive, bench-app, HUD shown):
 * - closed and reopened mid-run, or reloaded, its step log was empty: the log lived in view state;
 * - at the end there was no link to the run's result;
 * - a refusal or a reload left no word on the page.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { emptyImpactCounts, emptyImpactRecords, estimateImpactSavings } from '@reticlehq/core';
import { Presenter } from './presenter.js';
import { harnessRowHtml, HARNESS_ROW_TEXT, type HarnessRowState } from './presenter-harness-row.js';

const counts = emptyImpactCounts();
const scope = {
  counts,
  days: [],
  records: emptyImpactRecords(),
  savings: estimateImpactSavings(counts),
  since: 0,
};

const push = (p: Presenter, extra: Record<string, unknown>): void =>
  p.handlePush({
    name: 'impact',
    args: { snapshot: { schemaVersion: 1, project: scope, global: scope, ...extra } },
  });

const harnessLog = (): (string | undefined)[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>('[data-reticle-harness-log] [data-reticle-log-row]'),
  ).map((r) => r.querySelector('.reticle-log-text')?.textContent?.trim());

afterEach(() => {
  document.body.replaceChildren();
});

describe("the Harness page's step log", () => {
  it('is painted from the snapshot when the page holds none, and not twice', () => {
    const p = new Presenter({});
    p.mount();
    const drive = { runId: 'harness-1', steps: 2, lines: ['Opened /deployments', 'Clicked Save'] };
    push(p, { harnessDrive: drive });
    expect(harnessLog()).toEqual(['Opened /deployments', 'Clicked Save']);
    push(p, { harnessDrive: drive });
    expect(harnessLog()).toEqual(['Opened /deployments', 'Clicked Save']);
    p.destroy();
  });

  it('comes back after the HUD is taken down and put up again mid-run', () => {
    const drive = { runId: 'harness-2', steps: 1, lines: ['Opened /compose'] };
    const first = new Presenter({});
    first.mount();
    push(first, { harnessDrive: drive });
    first.destroy();
    const again = new Presenter({});
    again.mount();
    push(again, { harnessDrive: drive });
    expect(harnessLog()).toEqual(['Opened /compose']);
    again.destroy();
  });
});

describe("the Harness page's last word", () => {
  const ready: HarnessRowState = {
    account: { signedIn: true },
    config: { provider: 'reticle', harnessEnabled: true, harnessEntitled: true },
    drive: undefined,
    canDrive: true,
    pick: '',
    startedAs: undefined,
    setupUrl: 'http://localhost:5173/settings',
    planUrl: 'http://localhost:5173/settings?group=billing',
  };

  it('links the finished run beside Run', () => {
    const html = harnessRowHtml({
      ...ready,
      last: { runUrl: 'http://localhost:5173/runs/harness-1' },
    });
    expect(html).toContain(HARNESS_ROW_TEXT.RESULT);
    expect(html).toContain('href="http://localhost:5173/runs/harness-1"');
  });

  it('says why the last run stopped, or why none started', () => {
    const html = harnessRowHtml({
      ...ready,
      last: { said: 'The page reloaded, so this run stopped. Run again.' },
    });
    expect(html).toContain('The page reloaded, so this run stopped. Run again.');
    expect(html).toContain(HARNESS_ROW_TEXT.RUN);
  });

  it('never renders what it says as markup', () => {
    const html = harnessRowHtml({ ...ready, last: { said: '<img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('<img');
  });
});
