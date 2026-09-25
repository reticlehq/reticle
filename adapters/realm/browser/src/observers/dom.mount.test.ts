/**
 * A feature that mounts inside an unlabelled wrapper was invisible.
 *
 * `isMeaningful` drops an added node whose role is `generic` and which carries no accessible name.
 * As a filter on layout noise that is right — most bare `<div>`s are wrappers. But a mount arrives as
 * ONE childList record carrying the wrapper, and everything the feature is made of comes along INSIDE
 * it rather than as records of its own. So dropping the wrapper drops the whole subtree with it.
 *
 * MEASURED on bench-app. Opening the command palette — `<div class="palette-scrim">` wrapping
 * `<div class="palette" data-testid="palette">` — committed `paletteOpen: false -> true`, fired the
 * app's own `palette:opened`, ran its animations, and emitted NOT ONE DOM event. A raw
 * `MutationObserver` with this observer's exact config saw the mutation; this observer filtered it.
 *
 * What that cost is not a missing line in a log. `reticle_verify { action: "crawl" }` reported
 * `state-vs-render` against that button on every run — "the store committed a change, but nothing
 * rendered" — about an app that had rendered correctly. Every absence-derived rule reads this stream,
 * so a modal, drawer, sheet or popover in an unlabelled wrapper reads as a broken render.
 */
import { describe, it, expect } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installDom } from './dom.js';

interface Captured {
  type: EventType;
  data: Record<string, unknown>;
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function record(mutate: () => void): Promise<Captured[]> {
  const events: Captured[] = [];
  const teardown = installDom((type, data) => events.push({ type, data }));
  mutate();
  await flushMutations();
  teardown();
  return events;
}

const added = (events: Captured[]): Captured[] =>
  events.filter((e) => e.type === EventType.DOM_ADDED);

describe('a mount inside an unlabelled wrapper is still a render', () => {
  it('reports the palette that mounts inside a bare div', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      const events = await record(() => {
        // Exactly the shape bench-app uses: a scrim div wrapping the real thing.
        host.innerHTML =
          '<div class="palette-scrim"><div class="palette" data-testid="palette">' +
          '<input placeholder="Search or jump to…" /></div></div>';
      });
      expect(
        added(events).length,
        'a whole modal mounted and nothing was reported',
      ).toBeGreaterThan(0);
    } finally {
      host.remove();
    }
  });

  it('describes it by something inside, not by the wrapper it arrived in', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      const events = await record(() => {
        host.innerHTML = '<div><div role="dialog" aria-label="Command palette"></div></div>';
      });
      const roles = added(events).map((e) => e.data['role']);
      expect(roles).toContain('dialog');
    } finally {
      host.remove();
    }
  });

  // The filter still has to do its job: a wrapper carrying nothing is noise, and reporting it would
  // put a `dom.added` on every layout re-shuffle a framework performs.
  it('still ignores a wrapper with nothing meaningful inside it', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      const events = await record(() => {
        host.innerHTML = '<div><div><span></span></div></div>';
      });
      expect(added(events)).toEqual([]);
    } finally {
      host.remove();
    }
  });

  // Removal is the same claim in reverse: a dismissed modal must not read as "nothing happened".
  it('reports the removal of a feature that lived inside a bare div', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="scrim"><div role="dialog" aria-label="Confirm"></div></div>';
    document.body.appendChild(host);
    try {
      const events = await record(() => {
        host.innerHTML = '';
      });
      expect(events.filter((e) => e.type === EventType.DOM_REMOVED).length).toBeGreaterThan(0);
    } finally {
      host.remove();
    }
  });
});

/*
 * Driven on bench-app with route-transition-break injected: clicking Compose moved the URL to
 * /compose and left the Overview view on screen, and `act_and_wait { until: route contains
 * /compose }` came back verified:"yes". The rendered-nothing contradiction exists for exactly this
 * and did not fire, because the window held 40 dom.removed events - every one of them a saved-flow
 * button Reticle's own HUD had rebuilt. A removed node is detached, so `closest()` cannot climb from
 * it to the overlay it came out of; the parent it was removed FROM is still attached and can.
 */
describe("Reticle's own panel is not the app's DOM, including what it removes", () => {
  it('emits nothing when a node is removed from inside the overlay', async () => {
    document.body.innerHTML =
      '<div data-reticle-overlay><div class="flows"><button>▶ drive-view</button><button>▶ admin</button></div></div>';
    const list = document.querySelector('.flows');
    const events = await record(() => {
      list?.querySelectorAll('button').forEach((b) => b.remove());
    });
    expect(events.filter((e) => e.type === EventType.DOM_REMOVED)).toHaveLength(0);
  });

  it('still reports a node the app removes', async () => {
    document.body.innerHTML = '<main><button id="x">Save</button></main>';
    const events = await record(() => document.getElementById('x')?.remove());
    expect(events.filter((e) => e.type === EventType.DOM_REMOVED)).toHaveLength(1);
  });
});
