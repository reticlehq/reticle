import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { buildReactionReport, summarizeReaction } from './reaction.js';

function ev(type: EventType, data: Record<string, unknown> = {}): ReticleEvent {
  return { t: 1, type, sessionId: 's', data };
}

describe('summarizeReaction', () => {
  it('keeps window_ms + counts but drops the heavy events array', () => {
    const report = buildReactionReport(
      [ev(EventType.DOM_ADDED), ev(EventType.NET_REQUEST), ev(EventType.SIGNAL)],
      500,
    );
    const lean = summarizeReaction(report);
    // The digest carries every counter that MOVED plus `total`; the zeros are dropped (see the
    // sparse-digest block below). This used to assert `summary: report.summary` — equality with the
    // full report — which is the behaviour the route cut deliberately changed.
    expect(lean).toEqual({
      window_ms: 500,
      summary: { total: 3, domAdded: 1, network: 1, signals: 1 },
    });
    expect('events' in lean).toBe(false);
  });
});

describe('buildReactionReport summary (dom.text/dom.attr folding)', () => {
  // Test E — dom.text and dom.attr both fold into summary.domChanged; neither counts as domAdded.
  it('counts dom.text and dom.attr in domChanged, not domAdded', () => {
    const events = [
      ev(EventType.DOM_TEXT, { text: '1' }),
      ev(EventType.DOM_ATTR, { attr: 'class', value: 'open' }),
    ];
    const report = buildReactionReport(events, 500);
    expect(report.summary.domChanged).toBe(2);
    expect(report.summary.domAdded).toBe(0);
    expect(report.summary.domRemoved).toBe(0);
    expect(report.window_ms).toBe(500);
  });

  it('keeps add/remove separate from changed', () => {
    const events = [
      ev(EventType.DOM_ADDED, { role: 'dialog', name: 'x' }),
      ev(EventType.DOM_REMOVED, { role: 'dialog', name: 'x' }),
      ev(EventType.DOM_TEXT, { text: '2' }),
    ];
    const report = buildReactionReport(events, 100);
    expect(report.summary.domAdded).toBe(1);
    expect(report.summary.domRemoved).toBe(1);
    expect(report.summary.domChanged).toBe(1);
  });
});

/**
 * The digest ships on EVERY step of every replay and on every `act_and_wait`, and 69% of its
 * counters were measured to be zero on a real four-step replay — every step spelling out
 * `"network":0,"domAdded":0,"domRemoved":0,"routeChanges":0,"consoleErrors":0,"signals":0` whether
 * or not anything moved.
 *
 * Omitting a zero counter is a ROUTE cut, not an evidence cut: an absent counter IS zero, and the
 * reader answers the same question from the same facts. `total` stays unconditional — "the window
 * was empty" is itself evidence, and a digest with no keys at all would be ambiguous with one that
 * was never computed.
 *
 * The FULL report keeps every counter. Only the digest is sparse, because only the digest is the
 * thing re-sent per step.
 */
describe('summarizeReaction omits the counters that are zero', () => {
  it('drops zero counters and keeps the ones that moved', () => {
    const report = buildReactionReport([ev(EventType.DOM_ADDED), ev(EventType.SIGNAL)], 40);
    const lean = summarizeReaction(report);

    expect(lean.summary.domAdded).toBe(1);
    expect(lean.summary.signals).toBe(1);
    expect(lean.summary.total).toBe(2);

    // The zeros are ABSENT, not present-and-zero.
    expect('network' in lean.summary).toBe(false);
    expect('domRemoved' in lean.summary).toBe(false);
    expect('domChanged' in lean.summary).toBe(false);
    expect('routeChanges' in lean.summary).toBe(false);
    expect('consoleErrors' in lean.summary).toBe(false);
    expect('animations' in lean.summary).toBe(false);
  });

  it('keeps `total` even when the window was empty — an empty window is evidence', () => {
    const lean = summarizeReaction(buildReactionReport([], 12));
    expect(lean.summary.total).toBe(0);
    expect(lean.window_ms).toBe(12);
    expect(Object.keys(lean.summary)).toEqual(['total']);
  });

  it('leaves the FULL report untouched — every counter still present', () => {
    const report = buildReactionReport([ev(EventType.DOM_ADDED)], 40);
    expect(report.summary.network).toBe(0);
    expect(report.summary.signals).toBe(0);
  });
});
