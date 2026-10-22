/**
 * The UI moved over a failed write. Did the app go on as if it succeeded?
 *
 * The shapes are the recorded live incident feed, driven with no SDK in the app (zero-install). A new
 * row lands every 800 ms on its own. Acknowledging a row disables its button and POSTs; the POST is a
 * 500. The broken build carries on: the button reads "Acknowledged" and stays disabled. The fixed build
 * enables the button again and writes "Could not acknowledge …" into a banner. Both builds got
 * `ui-advanced-request-failed`, twice each, so the finding could not tell them apart.
 */
import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, isAbsenceDerived, type ReticleEvent } from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { TargetFate, targetFate } from './contradiction-evidence.js';

const BUTTON = 'e40';

let seq = 0;
function ev(type: EventType, data: Record<string, unknown>, ref?: string): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 's', data, ...(ref === undefined ? {} : { ref }) };
}

/** A feed row the app appended on its own, with its counter. Nothing the action did. */
const ambientRow = (n: number): ReticleEvent[] => [
  ev(EventType.DOM_ADDED, { role: 'generic', name: `INC-${String(1000 + n)}` }, `row${String(n)}`),
  ev(EventType.DOM_TEXT, { text: `${String(n)} open`, old: `${String(n - 1)} open` }, 'counter'),
];

/** Everything up to and including the 500: the optimistic pending state, then the failed POST. */
const pendingThenFailure = (): ReticleEvent[] => [
  ev(EventType.DOM_TEXT, { text: 'acknowledging', old: 'open' }, 'status3'),
  ev(EventType.DOM_ATTR, { attr: 'disabled', value: '' }, BUTTON),
  ...ambientRow(4),
  ev(EventType.NET_REQUEST, { id: 'n1', method: 'POST', url: '/api/fail', status: 500, ok: false }),
];

const broken = (): ReticleEvent[] => [
  ...pendingThenFailure(),
  ev(EventType.DOM_TEXT, { text: 'acknowledged', old: 'acknowledging' }, 'status3'),
  ev(EventType.DOM_TEXT, { text: 'Acknowledged', old: 'Acknowledge' }, BUTTON),
  ...ambientRow(5),
];

const fixed = (): ReticleEvent[] => [
  ...pendingThenFailure(),
  ev(EventType.DOM_TEXT, { text: 'open', old: 'acknowledging' }, 'status3'),
  ev(EventType.DOM_ATTR, { attr: 'disabled', old: '' }, BUTTON),
  // `button.textContent = 'Acknowledge'` replaces the text node with the same text: a no-op write.
  ev(EventType.DOM_TEXT, { text: 'Acknowledge', old: 'Acknowledge' }, BUTTON),
  ev(
    EventType.DOM_TEXT,
    { text: 'Could not acknowledge INC-1003: HTTP 500. Still open.' },
    'banner',
  ),
  ...ambientRow(5),
];

const kinds = (events: ReticleEvent[], options: Parameters<typeof findContradictions>[1]) =>
  findContradictions(events, { actionSince: 0, ...options }).map((c) => c.kind);

describe('the realtime pair, read by what became of the acted control', () => {
  it('keeps the finding on the build that went on as if the write succeeded', () => {
    expect(kinds(broken(), { ref: BUTTON, prior: [] })).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
  });

  it('has no finding on the build that rolled the control back', () => {
    expect(kinds(fixed(), { ref: BUTTON, prior: [] })).toEqual([]);
  });

  it('has no finding while the control still shows its in-flight state', () => {
    expect(kinds(pendingThenFailure(), { ref: BUTTON, prior: [] })).toEqual([]);
  });
});

describe('when the control cannot decide', () => {
  it('is weak when the app publishes no signal and no store change', () => {
    const found = kinds(fixed(), { prior: [] });
    expect(found).toEqual([ContradictionKind.UI_ADVANCED_UNSIGNALLED]);
    expect(isAbsenceDerived(ContradictionKind.UI_ADVANCED_UNSIGNALLED)).toBe(true);
  });

  it('stays strong when the app has a voice of its own', () => {
    const prior = [ev(EventType.SIGNAL, { name: 'incident:raised' })];
    expect(kinds(fixed(), { prior })).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });

  it("does not count Reticle's own signals as the app's voice", () => {
    const prior = [ev(EventType.SIGNAL, { name: 'reticle:hydrated' })];
    expect(kinds(fixed(), { prior })).toEqual([ContradictionKind.UI_ADVANCED_UNSIGNALLED]);
  });

  it('keeps the old reading when the caller did not look before the window', () => {
    expect(kinds(fixed(), {})).toEqual([ContradictionKind.UI_ADVANCED_REQUEST_FAILED]);
  });

  it('keeps the old reading when the control did not change before the failure', () => {
    const quietControl = [
      ev(EventType.DOM_ADDED, { role: 'listitem', name: 'new todo' }, 'li9'),
      ev(EventType.NET_REQUEST, {
        id: 'n2',
        method: 'POST',
        url: '/api/todos',
        status: 500,
        ok: false,
      }),
    ];
    expect(kinds(quietControl, { ref: BUTTON })).toEqual([
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
  });
});

/** The time the failed POST settled in this window. */
const failedAt = (events: readonly ReticleEvent[]): number =>
  events.find((e) => e.type === EventType.NET_REQUEST)?.t ?? -1;

describe('targetFate', () => {
  it('reads each of the three fates', () => {
    const persisted = broken();
    expect(targetFate(persisted, BUTTON, failedAt(persisted))).toBe(TargetFate.PERSISTED);
    const reverted = fixed();
    expect(targetFate(reverted, BUTTON, failedAt(reverted))).toBe(TargetFate.REVERTED);
    const pending = pendingThenFailure();
    expect(targetFate(pending, BUTTON, failedAt(pending))).toBe(TargetFate.PENDING);
  });

  it('cannot decide without a ref', () => {
    const events = broken();
    expect(targetFate(events, undefined, failedAt(events))).toBeUndefined();
  });
});
