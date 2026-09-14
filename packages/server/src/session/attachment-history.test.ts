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
import { z } from 'zod';
import { AttachmentHistory } from './attachment-history.js';
import { TOOLS } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';

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

  /**
   * These counters describe the SDK-to-daemon LINK, and nothing else.
   *
   * A zombie tab whose dev server had died reported `outages: 0` with a `connectedSinceMs` of 11
   * minutes, and both numbers were right: the page's socket was still attached. Read as app health
   * they said the app was up while nothing was listening on the port (#938). Nothing here can be
   * changed to fix that — the daemon cannot see the origin from this side — so the fix is that the
   * surface stops implying it, which is what these two pin.
   */
  describe('what these numbers do NOT measure', () => {
    it('a live link over a dead origin still reports zero outages', () => {
      // Nothing in this module is reachable from the origin dying, which is exactly the point: the
      // socket is between the daemon and a document the browser already holds.
      let now = 1_000;
      const h = new AttachmentHistory(() => now);
      h.attached('s1');
      now = 661_000; // 11 minutes, the reported figure
      expect(h.of('s1')).toEqual({ connectedSinceMs: 660_000, outages: 0 });
    });

    it('the reticle_sessions schema says so, where an agent actually reads it', () => {
      // The counters cannot be made honest by arithmetic, only by description. If that sentence is
      // ever dropped, the field goes back to over-claiming silently.
      const sessions = TOOLS.find((t) => t.name === ReticleTool.SESSIONS);
      const rows = (
        sessions?.outputSchema as Record<string, z.ZodArray<z.ZodObject<z.ZodRawShape>>>
      )['sessions'];
      const described = rows?.element.shape['attachment']?.description ?? '';
      expect(
        described,
        'the counters are honest only if the surface says what they scope to',
      ).toContain('NOT app health');
      // And the claim it replaced, which made the field's presence read as a warning.
      expect(described).not.toContain('Present only when this tab has dropped');
    });

    it('is reported for a tab that never dropped, not only after an outage', () => {
      // The schema used to say this field was "present only when this tab has dropped and
      // reconnected at least once", which made its mere presence read as a stability warning. It is
      // attached for any session the daemon has a record of.
      const h = new AttachmentHistory(() => 0);
      h.attached('fresh');
      expect(h.of('fresh')).toBeDefined();
      expect(h.of('fresh')?.outages).toBe(0);
    });
  });
});
