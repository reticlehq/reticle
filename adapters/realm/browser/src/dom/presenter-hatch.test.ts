/**
 * The escape hatch for the one app Reticle cannot otherwise verify: itself.
 *
 * Reticle's presenter is hidden from every tool by design, and the reason is sound — an agent that
 * can drive Reticle's own interface can fabricate its own impact report, and Reticle chrome is noise
 * in every other app on earth. The cost is that a HUD change is the only kind of change Reticle
 * cannot be used to check, because the panel rendering it is invisible to everything that could
 * look at it.
 *
 * So the hatch must be: off by default, total when open, and impossible to have open without
 * anybody noticing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isIgnored,
  isPresenterVisible,
  setIgnoreSelectors,
  setPresenterViewer,
  setPresenterVisible,
} from './dom-ignore.js';
import { getCapabilities } from '@/registry/capabilities.js';
import { Presenter } from '@/presenter/presenter.js';
import { matchQuery } from './query.js';

const el = (html: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild as Element;
};

afterEach(() => {
  setPresenterVisible(false);
  setPresenterViewer(false);
  setIgnoreSelectors([]);
});

describe('closed by default', () => {
  it('hides Reticle’s own HUD', () => {
    expect(isIgnored(el('<div data-reticle-hud><span>impact</span></div>'))).toBe(true);
  });

  it('hides every part of the presenter, not just the HUD', () => {
    for (const attr of ['data-reticle-overlay', 'data-reticle-cursor', 'data-reticle-glow']) {
      expect(isIgnored(el(`<div ${attr}></div>`)), attr).toBe(true);
    }
  });

  it('reports nothing in capabilities, because closed is the ordinary case', () => {
    expect(getCapabilities().presenterExposed).toBeUndefined();
  });
});

describe('open', () => {
  it('makes the HUD visible to snapshots and queries', () => {
    setPresenterVisible(true);
    expect(isIgnored(el('<div data-reticle-hud><span>impact</span></div>'))).toBe(false);
  });

  it('still hides third-party dev overlays — somebody else’s furniture is not the subject', () => {
    setPresenterVisible(true);
    expect(isIgnored(el('<nextjs-portal></nextjs-portal>'))).toBe(true);
    expect(isIgnored(el('<div data-agentation></div>'))).toBe(true);
  });

  it('still honours selectors the app asked to ignore', () => {
    setPresenterVisible(true);
    setIgnoreSelectors(['.my-dev-widget']);
    expect(isIgnored(el('<div class="my-dev-widget"></div>'))).toBe(true);
  });

  it('ANNOUNCES itself, so a verdict drawn with it open is never mistaken for an ordinary one', () => {
    setPresenterVisible(true);
    expect(getCapabilities().presenterExposed).toBe(true);
  });

  it('closes again cleanly', () => {
    setPresenterVisible(true);
    setPresenterVisible(false);
    expect(isPresenterVisible()).toBe(false);
    expect(isIgnored(el('<div data-reticle-hud></div>'))).toBe(true);
  });

  it('leaves ordinary app elements alone either way', () => {
    for (const open of [false, true]) {
      setPresenterVisible(open);
      expect(isIgnored(el('<button data-testid="submit">Go</button>')), String(open)).toBe(false);
    }
  });
});

/**
 * With the hatch open for dogfooding, the Harness model clicked the HUD's own plan card. The hatch is
 * for an agent verifying the HUD; the Harness never targets Reticle's own UI, open or not.
 */
describe('the Harness never sees the HUD', () => {
  it('hides the presenter from a Harness command even with the hatch open', () => {
    setPresenterVisible(true);
    const card = el('<div data-reticle-overlay><button>◐ Sign in with the Email</button></div>');
    expect(isIgnored(card)).toBe(false);
    setPresenterViewer(true);
    expect(isIgnored(card)).toBe(true);
    setPresenterViewer(false);
    expect(isIgnored(card)).toBe(false);
  });
});

/*
 * Platform drive: with the HUD exposed, its own narration ("Finding \"Open on dashboard\"")
 * satisfied the agent's text predicate — already_true on words the agent itself caused.
 */
describe("the HUD's narration is never a match source", () => {
  it('stays ignored with the hatch open, while the HUD controls are seen', () => {
    setPresenterVisible(true);
    expect(
      isIgnored(
        el(
          '<div data-reticle-hud><div data-reticle-log><span>Finding x</span></div></div>',
        ).querySelector('span') ?? el('<i></i>'),
      ),
    ).toBe(true);
    expect(
      isIgnored(
        el('<div data-reticle-hud><button>Run Harness</button></div>').querySelector('button') ??
          el('<i></i>'),
      ),
    ).toBe(false);
  });

  /*
   * The act strip's line ("Finding \"NEVER-SHOWN\"") was still a match source: with the HUD shown, a
   * visible-text `until` on words the app never rendered came back verified "yes".
   */
  it('ignores the act strip line the HUD writes for each call, while its buttons are seen', () => {
    document.body.replaceChildren();
    new Presenter().mount();
    setPresenterVisible(true);
    const line = document.querySelector('.reticle-act');
    const strip = document.querySelector('.reticle-act-strip');
    expect(line).not.toBeNull();
    expect(isIgnored(line ?? el('<i></i>'))).toBe(true);
    const button = strip?.querySelector('button');
    expect(button).not.toBeNull();
    expect(isIgnored(button ?? el('<i></i>'))).toBe(false);
  });
});

/*
 * Matrix drive, HUD exposed and shown: any words the HUD writes (a plan line, a persona, a finding)
 * could prove a text claim the app never made. A text claim reads the app's words only, hatch open
 * or not; the HUD's controls stay reachable by role and test id.
 */
describe('the HUD never counts as the app for a text claim', () => {
  const page = (): void => {
    document.body.innerHTML = `
      <main><p>Welcome back</p></main>
      <div data-reticle-hud><p>Plan: ONLY-IN-HUD sign in</p><button data-testid="hud-run">Run Harness</button></div>`;
  };

  it('finds no text the HUD alone shows, with the hatch open', () => {
    page();
    setPresenterVisible(true);
    expect(matchQuery({ text: 'ONLY-IN-HUD' }).matched).toBe(false);
    expect(matchQuery({ text: 'Run Harness' }).matched).toBe(false);
  });

  it("still finds the app's own text, and the HUD's controls by test id", () => {
    page();
    setPresenterVisible(true);
    expect(matchQuery({ text: 'Welcome back' }).matched).toBe(true);
    expect(matchQuery({ testid: 'hud-run' }).matched).toBe(true);
  });
});
