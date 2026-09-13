/**
 * `doctor` must not report a healthy setup to somebody whose app has never connected.
 *
 * Found by running it. Against a working daemon with a live app it printed node, chromium, daemon,
 * bridge port, log and tracing, and said nothing whatsoever about sessions — the word appears
 * nowhere in the command's output in either state. That makes it silent on the single step the
 * funnel actually stalls on: installed and wired, but no page has ever dialled in.
 *
 * The daemon already knew. `/status` carries `sessionCount` and `why`, and `doctor` was fetching
 * that exact payload to read `version` off it.
 */

import { describe, expect, it } from 'vitest';
import { sessionsLine } from './doctor-sessions-line.js';

describe('doctor says whether anything is connected', () => {
  it('reports connected pages when there are some', () => {
    expect(sessionsLine({ sessionCount: 2 }).text).toContain('2 pages connected');
    expect(sessionsLine({ sessionCount: 2 }).text).toContain('✓');
  });

  it('gets the singular right — a checklist reads as sloppy otherwise', () => {
    expect(sessionsLine({ sessionCount: 1 }).text).toContain('1 page connected');
  });

  it('marks zero as a FAILING check, not a neutral note', () => {
    // The whole defect: an all-✓ checklist told people their setup was fine while the one thing
    // that mattered was broken.
    const line = sessionsLine({ sessionCount: 0 });
    expect(line.text).toContain('✗');
    expect(line.text).toContain('no page has connected');
  });

  it('carries the daemon’s own diagnosis when there is nothing connected', () => {
    // Not a new diagnosis. This is the same text an agent gets from an empty reticle_sessions,
    // which is careful about what it can and cannot prove.
    const line = sessionsLine({ sessionCount: 0, why: 'run `reticle open <url>`' });
    expect(line.why).toBe('run `reticle open <url>`');
  });

  it('never prints a diagnosis beside a live session — it would contradict it', () => {
    expect(sessionsLine({ sessionCount: 3, why: 'nothing is connected' }).why).toBeUndefined();
  });

  it('says it does not know rather than claiming zero, when the daemon did not report', () => {
    // An older daemon sends no sessionCount. "0 connected" would be a claim about the app made from
    // a payload that never mentioned the app, which is the confident-wrong-sentence failure the
    // no-session diagnosis exists to avoid.
    for (const facts of [
      {},
      { sessionCount: 'two' },
      { sessionCount: -1 },
      { sessionCount: NaN },
    ]) {
      const line = sessionsLine(facts);
      expect(line.text).toContain('did not report');
      expect(line.text).not.toContain('✗');
      expect(line.why).toBeUndefined();
    }
  });
});
