import { describe, expect, it } from 'vitest';
import { InstrumentationGapKind } from '@reticlehq/core';
import { verdictIntentGap } from './verdict-intent-gap.js';

/**
 * A verdict that proves something nobody named says so.
 *
 * Intent capture works and is well built: an optional `intent` argument sits on the advertised
 * verdict tools, its description teaches what a durable statement looks like, and it writes the same
 * ledger `reticle_intent` writes. This repository's own ledger holds 89 of them, 55 proved.
 *
 * Nothing asks for it. The nudge existed on `flow_save` — `no-flow-intent` — and nowhere on the
 * per-action path, which is where a build-mode agent spends its whole life: drive, assert, get a
 * verdict, never hear the word intent. An optional capability nobody is told about is one nobody
 * uses, and that is not a guess about this codebase; the same shape was measured on `bodies` this
 * week, where an existing saving went untaken because its flag defaulted the expensive way.
 *
 * So a PASSING verdict with no intent now carries the gap. Three restrictions, each deliberate:
 *
 *  - Only on a pass. A red verdict has a finding to read; adding bookkeeping to a failure buries it.
 *  - Never on `no-fault`. Nothing was proved, so there is nothing an intent would have named.
 *  - Never derived. It says the intent is missing and never guesses what it was, for the reason the
 *    flow version gives: anything specific enough to identify the goal reads AS the goal.
 */
describe('verdictIntentGap', () => {
  it('asks for intent when a verdict PROVED something nobody named', () => {
    const gap = verdictIntentGap({ verified: 'yes', intent: undefined });
    expect(gap?.kind).toBe(InstrumentationGapKind.NO_FLOW_INTENT);
    expect(gap?.missing).toMatch(/intent/i);
  });

  it('is silent when the caller named one', () => {
    expect(
      verdictIntentGap({ verified: 'yes', intent: 'a shared filter is a shareable link' }),
    ).toBeUndefined();
  });

  it('is silent on a FAILURE — a red verdict already has something to read', () => {
    expect(verdictIntentGap({ verified: 'no', intent: undefined })).toBeUndefined();
  });

  it('is silent on no-fault — nothing was proved, so no intent was owed', () => {
    expect(verdictIntentGap({ verified: 'no-fault', intent: undefined })).toBeUndefined();
    expect(verdictIntentGap({ verified: 'unknown', intent: undefined })).toBeUndefined();
  });

  it('treats an empty or blank intent as absent, not as satisfied', () => {
    // `intent: ""` is the shape an agent produces when it means to comply and has nothing to say.
    expect(verdictIntentGap({ verified: 'yes', intent: '' })?.kind).toBe(
      InstrumentationGapKind.NO_FLOW_INTENT,
    );
    expect(verdictIntentGap({ verified: 'yes', intent: '   ' })?.kind).toBe(
      InstrumentationGapKind.NO_FLOW_INTENT,
    );
  });

  it('never guesses what the intent was', () => {
    const gap = verdictIntentGap({ verified: 'yes', intent: undefined });
    // The remedy tells the reader how to supply one; the gap itself names no behaviour, no step and
    // no assertion, because a guessed goal reads as the author's own words.
    expect(gap?.missing).not.toMatch(/button|click|login|submit/i);
  });
});
