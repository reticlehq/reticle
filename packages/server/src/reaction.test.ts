import { describe, it, expect } from 'vitest';
import { EventType, type IrisEvent } from '@iris/protocol';
import { buildReactionReport } from './reaction.js';

function ev(type: EventType, data: Record<string, unknown> = {}): IrisEvent {
  return { t: 1, type, sessionId: 's', data };
}

describe('buildReactionReport summary (M5.5 dom.text/dom.attr folding)', () => {
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
