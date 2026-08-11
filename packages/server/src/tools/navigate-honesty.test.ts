/**
 * `ok: true` from a navigation that may never have arrived.
 *
 * The browser's NAVIGATE command is `window.location.assign(url); return { ok: true, url }` —
 * returned SYNCHRONOUSLY, before the page goes anywhere. It cannot be otherwise: by the time the new
 * document exists, the SDK that would report on it has been torn down with the old one.
 *
 * So `ok` means "the navigation was dispatched", and the tool presented it as though it meant
 * "arrived". Driven live against a dead URL, `reticle_navigate` returned `{"ok":true}` — and the
 * browser session DIED, because the tab left the instrumented app. The agent is told the navigation
 * succeeded, is now looking at nothing, and has lost Reticle entirely.
 *
 * This repo already has the vocabulary for exactly this distinction: `reticle_act` separates
 * `dispatched` (the event was sent) from `settled` (a real frame flushed). Navigate collapsed both
 * into one optimistic word.
 *
 * The FIX here is the envelope, not the behaviour: `ok` keeps its meaning for existing callers, and
 * the result now says plainly that arrival is unconfirmed and how to confirm it. Making navigate
 * actually wait for the new session is a behaviour change with timing consequences, and is recorded
 * as a decision rather than taken.
 */

import { describe, expect, it } from 'vitest';
import { navigateResult } from './navigate-result.js';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';

describe('navigateResult', () => {
  it('keeps ok for existing callers', () => {
    expect(navigateResult({ ok: true, url: 'http://localhost:3000/x' })).toMatchObject({
      ok: true,
      url: 'http://localhost:3000/x',
    });
  });

  it('says arrival is UNCONFIRMED, because the SDK cannot survive the navigation to report it', () => {
    const out = navigateResult({ ok: true, url: 'http://x/y' });
    expect(out['confirmed']).toBe(false);
    expect(String(out['note'])).toMatch(/dispatch/i);
    // And names the way to actually check.
    expect(String(out['note'])).toContain('reticle_sessions');
  });

  it('does not claim dispatch when the browser refused outright', () => {
    // A refusal IS conclusive — the page never moved, so there is nothing unconfirmed about it.
    const out = navigateResult({ ok: false, reason: 'only http(s) navigation is allowed' });
    expect(out).toMatchObject({ ok: false, reason: 'only http(s) navigation is allowed' });
    expect(out['confirmed']).toBeUndefined();
    expect(out['note']).toBeUndefined();
  });

  it('passes a reason through when one is given', () => {
    expect(navigateResult({ ok: false, reason: 'url required' })['reason']).toBe('url required');
  });
});

/**
 * Honest was the first half. Useful is the second.
 *
 * Measured on all three fixtures on 2026-08-10: `confirmed` was `false` on every navigation, on
 * every app. A boolean that never varies teaches an agent nothing — and worse, an agent that learns
 * to ignore `confirmed` will keep ignoring it on the day it starts meaning something.
 *
 * The note told the agent to call `reticle_sessions` and poll for a session at the new URL. The
 * daemon can do that itself, and it is the one place that can: the SDK reconnects TO it. So every
 * navigation cost the agent a tool call it did not need to make, on a tool whose whole problem is
 * that it is the least reliable one we ship.
 */
describe('confirmed reports arrival when arrival is observable', () => {
  it('is true, and carries the reconnected sessionId, when a session arrives', () => {
    const out = navigateResult(
      { ok: true, url: 'http://localhost:3000/dashboard' },
      { sessionId: 's-new' },
    );
    expect(out['confirmed']).toBe(true);
    expect(out['sessionId'], 'the SDK reconnects as a NEW session — name it').toBe('s-new');
  });

  it('stays false, with the note, when nothing arrives in the window', () => {
    const out = navigateResult({ ok: true, url: 'http://localhost:3000/dashboard' }, null);
    expect(out['confirmed']).toBe(false);
    expect(String(out['note'])).toContain('reticle_sessions');
  });

  it('a refusal is still conclusive — no confirmed, no sessionId', () => {
    const out = navigateResult({ ok: false, reason: 'url required' }, null);
    expect(out['confirmed']).toBeUndefined();
    expect(out['sessionId']).toBeUndefined();
  });
});

/**
 * The description told the agent to call `reticle_sessions` after every navigation. That was correct
 * when `confirmed` was always false; it is now the wrong instruction on the common path, and a tool
 * whose guidance contradicts its own result is how an agent learns to trust neither.
 */
describe('the navigate description matches what navigate now returns', () => {
  const nav = TOOLS.find((t) => t.name === ReticleTool.NAVIGATE);

  it('tells the agent that confirmed:true means it can act', () => {
    expect(nav?.description).toContain('confirmed');
  });

  it('does not send the agent to reticle_sessions unconditionally', () => {
    const text = nav?.description ?? '';
    const tellsToPoll = /Call reticle_sessions to confirm/i.test(text);
    expect(
      tellsToPoll,
      'that instruction is now wrong whenever arrival was confirmed — the result already says so',
    ).toBe(false);
  });
});
