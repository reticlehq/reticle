/**
 * The log's own rows are trimmed and cleared by what they ARE, not by where they sit.
 *
 * The chat panel's top carousel lives inside the log's scroll container, as its first child, so new
 * rows push it up and out of view. Trimming by `firstElementChild` would delete it the moment the log
 * filled, and clearing with `replaceChildren` would wipe it on every new run.
 */
import { describe, expect, it } from 'vitest';
import { LOG_KIND } from './presenter-log.js';
import { appendLogRow, clearLogRows, trimLogRows } from './presenter-log.js';

function logWithPinned(): { log: HTMLElement; pinned: HTMLElement } {
  const log = document.createElement('div');
  const pinned = document.createElement('div');
  pinned.setAttribute('data-test-pinned', '');
  log.appendChild(pinned);
  return { log, pinned };
}

describe('log rows', () => {
  it('trims only rows, never what is pinned above them, and counts only rows', () => {
    const { log, pinned } = logWithPinned();
    for (let i = 0; i < 5; i += 1)
      appendLogRow(log, LOG_KIND.NARRATION, `row ${String(i)}`, '+0s', 3);
    expect(log.firstElementChild).toBe(pinned);
    expect(log.querySelectorAll('[data-reticle-log-row]')).toHaveLength(3);
  });

  it('trimLogRows keeps the newest rows and the pinned element', () => {
    const { log, pinned } = logWithPinned();
    for (let i = 0; i < 4; i += 1)
      appendLogRow(log, LOG_KIND.NARRATION, `r${String(i)}`, '+0s', 10);
    trimLogRows(log, 2);
    expect(log.firstElementChild).toBe(pinned);
    expect([...log.querySelectorAll('[data-reticle-log-row]')].map((r) => r.textContent)).toEqual([
      expect.stringContaining('r2'),
      expect.stringContaining('r3'),
    ]);
  });

  it('clearLogRows empties the rows and keeps the pinned element', () => {
    const { log, pinned } = logWithPinned();
    appendLogRow(log, LOG_KIND.NARRATION, 'a', '+0s', 10);
    clearLogRows(log);
    expect([...log.children]).toEqual([pinned]);
  });
});
