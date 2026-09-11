import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markDelivered, outboxPath, queueFeedback, readOutbox } from './feedback-outbox.js';

/**
 * Feedback is written down BEFORE the network is touched.
 *
 * It used to be sent on the same 2-second fire-and-forget budget as a usage counter, with no retry
 * and no persistence — so a 1.3-second hiccup destroyed the report. Measured to the collector with a
 * WARM DNS cache: total 0.694s, a third of the budget gone before a byte of payload moved, on the
 * GOOD path. The report that exposed this survived only because its author happened to have written
 * the markdown by hand first.
 */
describe('the feedback outbox', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'reticle-outbox-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('persists a report and returns its id', () => {
    const id = queueFeedback({ kind: 'bug', text: 'it broke' }, () => new Date(0), home);
    expect(id).not.toBeNull();
    const queued = readOutbox(home);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({ kind: 'bug', text: 'it broke' });
    expect(queued[0]?.t).toBe('1970-01-01T00:00:00.000Z');
  });

  it('keeps several reports, so a bad network hour does not overwrite the backlog', () => {
    queueFeedback({ n: 1 }, () => new Date(0), home);
    queueFeedback({ n: 2 }, () => new Date(0), home);
    expect(readOutbox(home).map((entry) => entry.payload)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('drops only the delivered one', () => {
    const first = queueFeedback({ n: 1 }, () => new Date(0), home);
    queueFeedback({ n: 2 }, () => new Date(0), home);
    markDelivered(first, home);
    expect(readOutbox(home).map((entry) => entry.payload)).toEqual([{ n: 2 }]);
  });

  it('survives a malformed line rather than losing the readable ones', () => {
    queueFeedback({ n: 1 }, () => new Date(0), home);
    appendFileSync(outboxPath(home), 'not json at all\n', 'utf8');
    queueFeedback({ n: 2 }, () => new Date(0), home);
    expect(readOutbox(home).map((entry) => entry.payload)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('reads as empty before anything is queued, without creating a file', () => {
    expect(readOutbox(home)).toEqual([]);
    expect(existsSync(outboxPath(home))).toBe(false);
  });

  it('marking an unknown id is harmless — a duplicate beats a loss', () => {
    queueFeedback({ n: 1 }, () => new Date(0), home);
    expect(() => markDelivered('no-such-id', home)).not.toThrow();
    expect(readOutbox(home)).toHaveLength(1);
  });
});
