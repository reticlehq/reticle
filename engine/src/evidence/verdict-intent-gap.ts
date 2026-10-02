import {
  InstrumentationGapKind,
  instrumentationGap,
  type InstrumentationGap,
} from '@reticlehq/core';

/**
 * A verdict that proved something nobody named, said out loud.
 *
 * Intent capture was already built and already reachable: an optional `intent` argument on the
 * advertised verdict tools, writing the same ledger `reticle_intent` writes. What was missing is
 * anybody asking for it. The nudge lived on `flow_save` alone, and a build-mode agent may never save
 * a flow — it drives, asserts, reads a verdict, and never hears the word.
 *
 * An optional capability nobody is told about is one nobody uses. That is not a guess about this
 * codebase: the same shape was measured on `reticle_network`'s `bodies` flag this week, where a real
 * saving went untaken for months because the flag defaulted the expensive way and nothing mentioned
 * it.
 *
 * Three restrictions, each deliberate:
 *
 *  - Only on a PASS. A red verdict already carries a finding worth the reader's attention, and
 *    bookkeeping stacked on a failure buries the thing that failed.
 *  - Never on `no-fault` or `unknown`. Nothing was proved, so no intent was owed — asking there would
 *    train the reader to ignore the ask.
 *  - Never derived. It reports that the statement is missing and never guesses what it was, for the
 *    reason `flowIntentGap` gives: anything specific enough to identify the goal is specific enough
 *    to be read AS the goal, and somebody will act on it.
 *
 * It never fails a verdict. A tool that refuses to record work is one people route around.
 */
export function verdictIntentGap(input: {
  verified: string;
  intent: string | undefined;
}): InstrumentationGap | undefined {
  if ('yes' !== input.verified) return undefined;
  // Blank is the shape an agent produces when it means to comply and has nothing to say. Treating it
  // as satisfied would turn the ask into a formality the first time somebody passed an empty string.
  if (input.intent !== undefined && input.intent.trim().length > 0) return undefined;
  return instrumentationGap(
    InstrumentationGapKind.NO_FLOW_INTENT,
    'this verdict proved something, and no intent says what it was meant to make true',
    'the pass is real but it is only about this run — six months from now the ledger can say a check went green and not what stopped being false, so a later agent re-derives the goal from the steps instead of reading it',
  );
}
