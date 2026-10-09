/**
 * The log's own rows are trimmed and cleared by what they ARE, not by where they sit.
 *
 * The chat panel's top carousel lives inside the log's scroll container, as its first child, so new
 * rows push it up and out of view. Trimming by `firstElementChild` would delete it the moment the log
 * filled, and clearing with `replaceChildren` would wipe it on every new run.
 */
import { describe, expect, it } from 'vitest';
import { LOG_CSS, LOG_EMPTY_TEXT, LOG_KIND } from './presenter-log.js';
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

/*
 * The empty log was a box saying only "Agent activity will appear here": nothing about what the HUD
 * is or how to make anything happen, which is all a first-time user needs from it.
 */
describe('the empty log', () => {
  it('says what Reticle is and both ways to start, in the stylesheet that paints it', () => {
    expect(LOG_CSS).toContain(LOG_EMPTY_TEXT.TITLE);
    expect(LOG_EMPTY_TEXT.BODY).toContain('Ask your coding agent');
    expect(LOG_EMPTY_TEXT.BODY).toContain('Harness');
    expect(LOG_CSS).not.toContain('Agent activity will appear here');
  });
});
