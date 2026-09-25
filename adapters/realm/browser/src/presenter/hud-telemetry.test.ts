import { afterEach, describe, expect, it } from 'vitest';
import {
  HudPanel,
  HudToggle,
  HudView,
  emptyImpactCounts,
  emptyImpactRecords,
  type HudUseData,
} from '@reticlehq/core';
import { isHudControl } from '@reticlehq/core/hud';
import { Presenter } from './presenter.js';
import { controlIdOf } from './hud-telemetry.js';
import { settingsPanelHtml } from './presenter-settings.js';
import { reportBodyHtml, reportPanelHtml } from './presenter-report.js';
import { accountControlHtml, syncButtonHtml } from './presenter-account.js';
import { carouselHtml } from './carousel/carousel.js';
import { offerHtml } from './carousel/offer-card.js';
import { talkCardHtml } from './carousel/talk-card.js';
import { slideHtml, tourSlides } from './tour/tour-view.js';
import { flush } from './presenter.test-helpers.js';

/**
 * Every control on the HUD is counted, and counted by a name core accepts.
 *
 * The listener names a press from the control's own attribute, so there is nothing to wire per
 * button, but a control with no attribute, or with one core does not list, would be pressed and
 * silently never counted. The owner asked for exactly this: every element on the HUD measured. So
 * this walks the markup the HUD actually renders, every surface of it, and names what is missing.
 */
const CONTROL_SEL = 'button, a[href], [role="switch"], [role="checkbox"]';
const DASHBOARD = 'https://app.reticle.sh/p/demo';

function everySurface(): string {
  const account = { signedIn: true, org: 'Acme', host: 'app.reticle.sh' };
  const counts = { ...emptyImpactCounts(), verdicts: 4, passed: 1, failed: 3 };
  const scope = {
    counts,
    days: [{ date: '2026-08-20', counts }],
    records: { ...emptyImpactRecords(), streakDays: 2 },
    defects: [{ title: 'Pay does nothing', detail: 'no request', source: 'src/Pay.tsx:1' }],
  };
  return [
    settingsPanelHtml(),
    reportPanelHtml(),
    reportBodyHtml(scope as never, DASHBOARD, account, 'demo'),
    accountControlHtml(account, { dashboardUrl: DASHBOARD }),
    accountControlHtml(account, {}),
    accountControlHtml({ signedIn: false }, {}, true),
    syncButtonHtml(DASHBOARD),
    carouselHtml(
      [
        { id: 'offer', html: offerHtml({ claimed: false, claimUrl: DASHBOARD }, false) },
        { id: 'talk', html: talkCardHtml() },
      ],
      0,
    ),
    ...tourSlides().map((s) => slideHtml(s)),
  ].join('');
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('every HUD control is counted by name', () => {
  it('names every control on every surface with an id core accepts', () => {
    const presenter = new Presenter({ onHudUse: () => undefined });
    presenter.mount();
    // Theme chips are built when Settings opens.
    document.querySelector<HTMLElement>('[data-reticle-settings-btn]')?.click();
    expect(document.querySelectorAll('[data-reticle-theme]').length).toBeGreaterThan(0);
    const extra = document.createElement('div');
    extra.setAttribute('data-reticle-hud', '');
    extra.innerHTML = everySurface();
    document.body.appendChild(extra);

    const controls = [...document.querySelectorAll(CONTROL_SEL)];
    expect(controls.length).toBeGreaterThan(40);
    const unnamed = controls
      .filter((el) => controlIdOf(el) === undefined)
      .map((el) => el.outerHTML.slice(0, 120));
    expect(unnamed).toEqual([]);
    presenter.destroy();
  });

  it('names the annotation popover buttons', () => {
    const send = document.createElement('button');
    send.setAttribute('data-send', '');
    send.setAttribute('data-reticle-mark-send', '');
    expect(controlIdOf(send)).toBe('mark-send');
  });

  it('never names a control by a value somebody else chose', () => {
    const replay = document.createElement('button');
    replay.setAttribute('data-reticle-replay', 'checkout for acme corp');
    expect(controlIdOf(replay)).toBe('replay');
    const forged = document.createElement('a');
    forged.setAttribute('data-reticle-link', 'somebody@example.com');
    expect(controlIdOf(forged)).toBeUndefined();
    expect(isHudControl('link.somebody@example.com')).toBe(false);
  });
});

describe('reporting HUD use', () => {
  it('reports a press, a toggle with the state it landed in, and where the HUD sits', async () => {
    const seen: HudUseData[] = [];
    const presenter = new Presenter({ onHudUse: (u) => seen.push(u) });
    presenter.mount();
    expect(seen[0]).toEqual({ view: HudView.BUBBLE, panel: HudPanel.NONE });

    document.querySelector<HTMLElement>('[data-reticle-fab]')?.click();
    await flush();
    expect(seen).toContainEqual({ control: 'fab' });
    expect(seen).toContainEqual({ view: HudView.EXPANDED, panel: HudPanel.CHAT });

    document.querySelector<HTMLElement>('[data-reticle-settings-btn]')?.click();
    await flush();
    expect(seen).toContainEqual({ view: HudView.EXPANDED, panel: HudPanel.SETTINGS });

    document.querySelector<HTMLElement>('[data-reticle-setting="reduceMotion"]')?.click();
    await flush();
    await flush();
    expect(seen).toContainEqual({ control: 'setting.reduceMotion', toggle: HudToggle.ON });
    presenter.destroy();
  });

  it('stops reporting once the HUD is gone', () => {
    const seen: HudUseData[] = [];
    const presenter = new Presenter({ onHudUse: (u) => seen.push(u) });
    presenter.mount();
    const pause = document.querySelector<HTMLElement>('[data-reticle-pause]');
    presenter.destroy();
    const before = seen.length;
    document.body.appendChild(pause ?? document.createElement('div'));
    pause?.click();
    expect(seen.length).toBe(before);
  });
});
