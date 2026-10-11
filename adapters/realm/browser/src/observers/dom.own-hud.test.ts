/**
 * Dogfood: with `exposePresenter` on, Reticle can see and drive its own HUD, and an agent asserting
 * on it needs the HUD's changes on the timeline too. The snapshot and queries already honoured the
 * hatch; the DOM observer did not, so "Run Harness became Stop" was a change no wait could see.
 * Only the HUD's panels open up: the cursor and glow move on every action and stay unobserved.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installDom } from './dom.js';
import { setPresenterVisible } from '@/dom/dom-ignore.js';
import { elementsMatching } from '@/dom/query.js';
import { harnessRowHtml } from '@/presenter/presenter-harness-row.js';

async function record(mutate: () => void): Promise<EventType[]> {
  const events: EventType[] = [];
  const teardown = installDom((type) => events.push(type));
  mutate();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  teardown();
  return events;
}

const hud = (): HTMLElement => {
  document.body.innerHTML =
    '<div data-reticle-overlay><div data-reticle-dock><button data-reticle-harness-run>Run Harness</button></div><div data-reticle-cursor><span>x</span></div></div>';
  return document.querySelector('[data-reticle-harness-run]') as HTMLElement;
};

afterEach(() => {
  setPresenterVisible(false);
  document.body.innerHTML = '';
});

describe("the HUD's own changes on the timeline", () => {
  it('are not observed by default', async () => {
    const run = hud();
    expect(await record(() => (run.textContent = 'Stop'))).toEqual([]);
  });

  it('are observed with the hatch open, the cursor still is not', async () => {
    setPresenterVisible(true);
    const run = hud();
    expect(await record(() => (run.textContent = 'Stop'))).toContain(EventType.DOM_TEXT);
    const cursor = document.querySelector('[data-reticle-cursor] span') as HTMLElement;
    expect(await record(() => (cursor.textContent = 'moved'))).toEqual([]);
  });
});

describe('an agent can find the HUD’s own controls with the hatch open', () => {
  const page = (): void => {
    document.body.innerHTML = `<div data-reticle-overlay><div data-reticle-dock><section data-reticle-harness-page>${harnessRowHtml(
      {
        account: { signedIn: true },
        config: { provider: 'jev', harnessEnabled: true, harnessEntitled: true },
        drive: undefined,
        canDrive: true,
        pick: 'first-time',
        startedAs: undefined,
        setupUrl: '',
        planUrl: '',
      },
    )}</section></div></div>`;
  };

  it('finds Run Harness by its role and name only when the hatch is open', () => {
    page();
    expect(elementsMatching({ role: 'button', name: 'Run Harness' })).toHaveLength(0);
    setPresenterVisible(true);
    expect(elementsMatching({ role: 'button', name: 'Run Harness' })).toHaveLength(1);
  });
});
