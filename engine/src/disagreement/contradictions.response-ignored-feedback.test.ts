import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, NetInitiator, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';

/**
 * `response-ignored` stood down on an app that ignored its response (#2115).
 *
 * The rule fires only when nothing on the client moved. The acted control becoming `disabled` or
 * `aria-busy` after the write was sent counted as movement. That is the control saying "wait" while
 * the request runs. It does not answer the write, and the rule went silent on an app that ignored a
 * 2xx. A change before the send is not about the write at all. A change after the send that stops
 * the waiting still counts: the app can only do that once it heard back.
 *
 * The order is the page's own sequence number, so these windows hold no time at all.
 */
const SAVE_URL = '/api/saved-items';
const BUTTON = 'e37';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown> = {}, ref?: string): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data, ...(ref === undefined ? {} : { ref }) };
}

const sent = (id: string, url = SAVE_URL, extra: Record<string, unknown> = {}): ReticleEvent =>
  ev(EventType.NET_PENDING, { id, method: 'POST', url, initiator: NetInitiator.FETCH, ...extra });
const answered = (id: string, url = SAVE_URL, extra: Record<string, unknown> = {}): ReticleEvent =>
  ev(EventType.NET_REQUEST, {
    id,
    method: 'POST',
    url,
    status: 200,
    ok: true,
    initiator: NetInitiator.FETCH,
    ...extra,
  });
const disabled = (ref = BUTTON): ReticleEvent =>
  ev(EventType.DOM_ATTR, { attr: 'disabled', value: '' }, ref);
const enabled = (ref = BUTTON): ReticleEvent =>
  ev(EventType.DOM_ATTR, { attr: 'disabled', old: '' }, ref);

const kinds = (events: ReticleEvent[]): string[] =>
  findContradictions(events, { action: 'click', ref: BUTTON, actionSince: 0 }).map((c) => c.kind);

describe('response-ignored: the acted control waiting is not an answer', () => {
  it('fires when the button is disabled while the write runs and nothing else moves', () => {
    expect(kinds([sent('n1'), disabled(), answered('n1')])).toEqual([
      ContradictionKind.RESPONSE_IGNORED,
    ]);
  });

  // The shape of the failed merge-queue run, as far as its summary shows it: one write, one 2xx,
  // no store, signal or route change, and a DOM change the filtered summary hid.
  it('fires when the control was enabled before the send and nothing else moves', () => {
    expect(kinds([enabled(), sent('n1'), answered('n1')])).toEqual([
      ContradictionKind.RESPONSE_IGNORED,
    ]);
  });

  it('fires when the button is marked aria-busy while the write runs', () => {
    expect(
      kinds([
        sent('n1'),
        ev(EventType.DOM_ATTR, { attr: 'aria-busy', value: 'true' }, BUTTON),
        answered('n1'),
      ]),
    ).toEqual([ContradictionKind.RESPONSE_IGNORED]);
  });

  it('fires for every write when two of them leave the button waiting', () => {
    expect(
      kinds([
        sent('n1'),
        sent('n2', '/api/audit'),
        disabled(),
        answered('n1'),
        answered('n2', '/api/audit'),
      ]),
    ).toEqual([ContradictionKind.RESPONSE_IGNORED]);
  });

  // A limit, on purpose: a settings form whose only answer is enabling Save again is correct.
  it('stays silent when the button is enabled again after the answer', () => {
    expect(kinds([sent('n1'), disabled(), answered('n1'), enabled()])).toEqual([]);
  });

  it('stays silent when the client renders after the answer', () => {
    expect(
      kinds([sent('n1'), disabled(), answered('n1'), ev(EventType.DOM_ADDED, { path: 'li' })]),
    ).toEqual([]);
  });

  it('fires when the button is disabled between two answers', () => {
    expect(
      kinds([
        sent('n1'),
        sent('n2', '/api/audit'),
        answered('n1'),
        disabled(),
        answered('n2', '/api/audit'),
      ]),
    ).toEqual([ContradictionKind.RESPONSE_IGNORED]);
  });

  it('stays silent when the button is enabled between two answers', () => {
    expect(
      kinds([
        sent('n1'),
        disabled(),
        sent('n2', '/api/audit'),
        answered('n1'),
        enabled(),
        answered('n2', '/api/audit'),
      ]),
    ).toEqual([]);
  });

  // An XHR answer is recorded on `loadend`, after the app's `load` handler and after axios's. A
  // form that enables Save again in its response handler has that change recorded before the answer.
  it('stays silent when the button is enabled again before the answer is recorded', () => {
    expect(kinds([sent('n1'), disabled(), enabled(), answered('n1')])).toEqual([]);
  });

  it('stays silent when an XHR form enables its button in the load handler', () => {
    expect(
      kinds([
        sent('n1', SAVE_URL, { initiator: NetInitiator.XHR }),
        disabled(),
        enabled(),
        answered('n1', SAVE_URL, { initiator: NetInitiator.XHR }),
      ]),
    ).toEqual([]);
  });

  it('stays silent when the button stops being busy before the answer is recorded', () => {
    expect(
      kinds([
        sent('n1'),
        ev(EventType.DOM_ATTR, { attr: 'aria-busy', value: 'true' }, BUTTON),
        ev(EventType.DOM_ATTR, { attr: 'aria-busy', value: 'false', old: 'true' }, BUTTON),
        answered('n1'),
      ]),
    ).toEqual([]);
  });

  it('fires when the button was disabled before the send and nothing else moves', () => {
    expect(kinds([disabled(), sent('n1'), answered('n1')])).toEqual([
      ContradictionKind.RESPONSE_IGNORED,
    ]);
  });

  // Without the send, nothing says which change came after it.
  it('keeps every change when the window does not hold the send', () => {
    expect(kinds([disabled(), answered('n1')])).toEqual([]);
  });

  // Only `disabled` and `aria-busy` on the acted control. Anything else can be an optimistic update.
  it('stays silent when another element is disabled before the answer', () => {
    expect(kinds([sent('n1'), disabled('e99'), answered('n1')])).toEqual([]);
  });

  // A limit, on purpose: a label can carry the result, such as a count on a like button.
  it('stays silent when the control label changes before the answer', () => {
    expect(
      kinds([sent('n1'), ev(EventType.DOM_TEXT, { text: 'Saving…' }, BUTTON), answered('n1')]),
    ).toEqual([]);
  });

  it('stays silent when the control changes another attribute before the answer', () => {
    expect(
      kinds([
        sent('n1'),
        ev(EventType.DOM_ATTR, { attr: 'aria-checked', value: 'true' }, BUTTON),
        answered('n1'),
      ]),
    ).toEqual([]);
  });

  it('stays silent when the store changed optimistically before the answer', () => {
    expect(
      kinds([
        sent('n1'),
        disabled(),
        ev(EventType.STATE_CHANGE, { store: 'app', path: 'savedItems' }),
        answered('n1'),
      ]),
    ).toEqual([]);
  });

  // Without the acted control, nothing says which change was the control waiting.
  it('keeps every change when no control was acted on', () => {
    expect(
      findContradictions([sent('n1'), disabled(), answered('n1')], {
        action: 'click',
        actionSince: 0,
      }).map((c) => c.kind),
    ).toEqual([]);
  });

  // The saved-items fixture captures bodies, so its answer is recorded after the body was read.
  it('fires when the answer was recorded after its body was read', () => {
    expect(
      kinds([sent('n1'), disabled(), answered('n1', SAVE_URL, { responseBody: '{"id":1}' })]),
    ).toEqual([ContradictionKind.RESPONSE_IGNORED]);
  });

  it('fires when the write went through XHR', () => {
    expect(
      kinds([sent('n1'), disabled(), answered('n1', SAVE_URL, { initiator: NetInitiator.XHR })]),
    ).toEqual([ContradictionKind.RESPONSE_IGNORED]);
  });

  it('stays silent over a window no action opened', () => {
    expect(
      findContradictions([sent('n1'), disabled(), answered('n1')], { ref: BUTTON }).map(
        (c) => c.kind,
      ),
    ).toEqual([]);
  });
});
