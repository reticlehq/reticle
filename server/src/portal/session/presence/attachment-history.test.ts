/**
 * "Was this session attached for the whole window I am about to reason about?"
 *
 * `reticle_sessions` answers "which tabs are connected RIGHT NOW". It cannot answer the question
 * that actually decides whether a verdict is trustworthy — and **a tab that dropped for 4 seconds
 * and came back looks identical to one that never dropped.**
 *
 * From #117. It is the same class of problem `honesty.integrity` solves for a single action, applied
 * to the session: a green over a window you did not fully observe is a statement about what you
 * happened to see.
 *
 * The issue proposes reading this off the SDK, which tracks `#disconnectedSince` in
 * `transport.ts:95`. That would need a wire change. It is not necessary: **the daemon already sees
 * both halves** — `remove()` when the socket drops and `add()` when it comes back — so the gap is
 * measurable here, with no protocol change and nothing new for the browser to report.
 */

import { describe, expect, it } from 'vitest';
import { AttachmentHistory } from './attachment-history.js';

describe('AttachmentHistory', () => {
  it('a session seen once has no outages and is attached since it arrived', () => {
    const h = new AttachmentHistory(() => 1_000);
    h.attached('s1');
    expect(h.of('s1')).toEqual({ connectedSinceMs: 0, outages: 0 });
  });

  it('reports how long the current attachment has lasted', () => {
    let now = 1_000;
    const h = new AttachmentHistory(() => now);
    h.attached('s1');
    now = 41_230;
    expect(h.of('s1')?.connectedSinceMs).toBe(40_230);
  });

  it('counts a reconnect as an outage and measures the gap', () => {
    let now = 1_000;
    const h = new AttachmentHistory(() => now);
    h.attached('s1');
    now = 5_000;
    h.detached('s1');
    now = 9_180;
    h.attached('s1');

    const info = h.of('s1');
    expect(info?.outages).toBe(1);
    expect(info?.lastOutage?.durationMs, 'the gap is what makes an earlier verdict suspect').toBe(
      4_180,
    );
  });

  it('the clock restarts on reconnect — connectedSince is about THIS attachment', () => {
    let now = 0;
    const h = new AttachmentHistory(() => now);
    h.attached('s1');
    now = 10_000;
    h.detached('s1');
    now = 12_000;
    h.attached('s1');
    now = 12_500;
    expect(h.of('s1')?.connectedSinceMs, 'it reported the whole lifetime, gap included').toBe(500);
  });

  it('accumulates across several outages', () => {
    let now = 0;
    const h = new AttachmentHistory(() => now);
    h.attached('s1');
    const gaps: readonly (readonly [number, number])[] = [
      [100, 200],
      [300, 450],
    ];
    for (const [down, up] of gaps) {
      now = down;
      h.detached('s1');
      now = up;
      h.attached('s1');
    }
    expect(h.of('s1')?.outages).toBe(2);
    expect(h.of('s1')?.lastOutage?.durationMs).toBe(150);
  });

  it('knows nothing about a session it never saw, rather than inventing zeroes', () => {
    const h = new AttachmentHistory(() => 0);
    expect(h.of('ghost'), 'a confident zero would read as "never dropped"').toBeUndefined();
  });

  it('forgets a session when told to, so a long-lived daemon does not grow without bound', () => {
    const h = new AttachmentHistory(() => 0);
    h.attached('s1');
    h.forget('s1');
    expect(h.of('s1')).toBeUndefined();
  });
});
