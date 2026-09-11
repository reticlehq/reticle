/**
 * A poll must never report "nothing" about something the human actually said.
 *
 * Reported by an agent: a user typed into the HUD's chat box, the next turn polled for messages and
 * got `{"messages":[], "observed":true, "note":"no messages from the human since the last poll…"}`
 * — clean, confident, and wrong. The message had already been DRAINED, because the inbox has two
 * consumers: the control envelope spliced onto every tool result, and this explicit poll. Whichever
 * runs first takes the message and the other truthfully-but-uselessly reports an empty queue.
 *
 * From the human's side it is worse: they typed something, got no reply, and nothing anywhere said
 * the message was ever received. "I typed something and got silence" is ambiguous between not-sent,
 * not-seen, and seen-but-ignored.
 *
 * Delivered-once is still right for GUIDANCE — a hint that repeats every turn is noise. So the fix
 * is not to stop draining, it is to stop forgetting: a drained message stays in the session's
 * history, and a poll that finds nothing new can say what was already handed over instead of
 * implying nothing was said.
 */

import { describe, expect, it } from 'vitest';
import { LiveControl } from './live-control.js';

describe('inbox history', () => {
  it('still delivers a queued message exactly once', () => {
    const live = new LiveControl();
    live.push('check the totals', 100);
    expect(live.drain().map((m) => m.text)).toEqual(['check the totals']);
    expect(live.drain()).toEqual([]);
  });

  it('remembers a message after it has been delivered', () => {
    const live = new LiveControl();
    live.push('check the totals', 100);
    live.drain();
    expect(live.history().map((m) => m.text)).toEqual(['check the totals']);
  });

  it('separates what is still undelivered from what the human has said in total', () => {
    const live = new LiveControl();
    live.push('first', 1);
    live.drain();
    live.push('second', 2);
    expect(live.size()).toBe(1);
    expect(live.history()).toHaveLength(2);
  });

  it('keeps history in the order the human said things', () => {
    const live = new LiveControl();
    live.push('one', 1);
    live.push('two', 2);
    live.drain();
    live.push('three', 3);
    expect(live.history().map((m) => m.text)).toEqual(['one', 'two', 'three']);
  });

  it('ignores blank input, so a stray enter never becomes a phantom message', () => {
    const live = new LiveControl();
    live.push('   ', 1);
    expect(live.history()).toEqual([]);
  });

  it('bounds the history, so a long session cannot grow without limit', () => {
    const live = new LiveControl();
    for (let i = 0; i < 500; i += 1) live.push(`m${String(i)}`, i);
    expect(live.history().length).toBeLessThanOrEqual(200);
    // The most RECENT are what matter to an agent picking up a session.
    expect(live.history().at(-1)?.text).toBe('m499');
  });
});
