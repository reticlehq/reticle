import { describe, expect, it } from 'vitest';
import { RecordingStore } from './recording/tape/recordings.js';
import { captureAct } from './replay.js';

/*
 * A journey goes on when the app loads a new page.
 *
 * A server-rendered app submits a form with a full page load, and each page is a new session. The
 * agent filled "Search tags" on one page and clicked Search, which loaded the next page. The fill
 * stayed on the first session's tape, had no check, and was dropped at that session's end. The
 * click went to the next session's tape and was saved alone, so the flow clicked Search on an empty
 * field: a false fail on a correct app.
 */
const fill = { target: { label: 'Search tags' }, action: 'fill', args: { value: 're' } };
const search = {
  target: { role: 'button', name: 'Search' },
  action: 'click',
  until: { kind: 'route', contains: 'search=re' },
};

describe('the ambient tape across a page that the app loads', () => {
  it('starts the next page with a tape that had no check', () => {
    const store = new RecordingStore(undefined, (id) => ('page-1' === id ? 'page-2' : undefined));
    captureAct(store, fill, { ok: true }, '/tags', 'page-1');
    store.takeAmbient('page-1');
    captureAct(store, search, { ok: true }, '/tags', 'page-2');
    const second = store.takeAmbient('page-2');
    expect(second?.steps.map((s) => s.args['action'])).toEqual(['fill', 'click']);
  });

  // The click is recorded on the next page when its check holds there, and that can come before
  // the first page's session end. The carried steps then go in front of the tape that exists.
  it('puts them in front when the next page recorded its step first', () => {
    const store = new RecordingStore(undefined, (id) => ('page-1' === id ? 'page-2' : undefined));
    captureAct(store, fill, { ok: true }, '/tags', 'page-1');
    captureAct(store, search, { ok: true }, '/tags', 'page-2');
    store.takeAmbient('page-1');
    const second = store.takeAmbient('page-2');
    expect(second?.steps.map((s) => s.args['action'])).toEqual(['fill', 'click']);
  });

  // A leased tab keeps its session id across a page load: the page ends and comes back as itself.
  it('starts the same session again with them when the tab keeps its id', () => {
    const store = new RecordingStore();
    captureAct(store, fill, { ok: true }, '/tags', 'lease-1');
    store.takeAmbient('lease-1');
    captureAct(store, search, { ok: true }, '/tags', 'lease-1');
    const again = store.takeAmbient('lease-1');
    expect(again?.steps.map((s) => s.args['action'])).toEqual(['fill', 'click']);
  });

  it('keeps them on their own page when Reticle navigated away', () => {
    const store = new RecordingStore(undefined, () => 'page-2');
    captureAct(store, fill, { ok: true }, '/tags', 'page-1');
    store.markNavigated();
    store.takeAmbient('page-1');
    captureAct(store, search, { ok: true }, '/tags', 'page-2');
    expect(store.takeAmbient('page-2')?.steps.map((s) => s.args['action'])).toEqual(['click']);
  });
});
