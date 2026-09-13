import { describe, expect, it } from 'vitest';
import {
  IntentState,
  INTENT_FILE_VERSION,
  IntentFileSchema,
  bindIntent,
  declareIntent,
  dischargeIntent,
  emptyIntentFile,
  openIntents,
  upsertIntent,
} from './intent.js';

/**
 * An agent building a feature knows what it is for. That knowledge is in its context, and then the
 * turn ends and the context goes. Later — a different turn, a different session, a different model —
 * something drives the app and has to decide whether the feature works, with the DOM, the diff, and
 * no intent. So it asserts what it can SEE rather than what was MEANT, and what it can see is
 * weaker.
 *
 * The prose is captured EARLY, where fidelity is highest and bindability is zero. The predicate is
 * bound LATE, where bindability is highest and fidelity has decayed. Capturing at either end alone
 * loses one of the two.
 */

const NOW = 1_000;

describe('declareIntent', () => {
  it('captures the prose without demanding a predicate', () => {
    const intent = declareIntent({
      id: 'itn_checkin',
      statement: 'A user who clicks Send check-in sees the trip badge read "checked in"',
      now: NOW,
    });
    expect(intent.statement).toContain('checked in');
    expect(intent.state).toBe(IntentState.DECLARED);
    expect(intent.binding).toBeUndefined();
  });

  /**
   * The whole reason the prose is mandatory and the predicate is not. At declare time there is no
   * route, no ref and often no code — demanding a predicate there would collect mechanisms, which is
   * what we already have.
   */
  it('is DECLARED, not bound, until something says how it would be proved', () => {
    const intent = declareIntent({ id: 'i1', statement: 'users can recover a password', now: NOW });
    expect(intent.state).toBe(IntentState.DECLARED);
  });

  it('records when and against what it was declared', () => {
    const intent = declareIntent({
      id: 'i1',
      statement: 's',
      now: NOW,
      surface: { route: '/trips', files: ['TripCard.tsx'] },
    });
    expect(intent.declaredAt).toBe(NOW);
    expect(intent.surface?.route).toBe('/trips');
  });
});

describe('bindIntent', () => {
  it('moves a declared intent to BOUND once a predicate exists', () => {
    const bound = bindIntent(declareIntent({ id: 'i1', statement: 's', now: NOW }), {
      kind: 'text',
      value: 'checked in',
    });
    expect(bound.state).toBe(IntentState.BOUND);
    expect(bound.binding).toEqual({ kind: 'text', value: 'checked in' });
  });

  it('leaves the prose exactly as declared', () => {
    const declared = declareIntent({ id: 'i1', statement: 'the original words', now: NOW });
    expect(bindIntent(declared, { kind: 'text' }).statement).toBe('the original words');
  });

  it('does not mutate what it was given', () => {
    const declared = declareIntent({ id: 'i1', statement: 's', now: NOW });
    bindIntent(declared, { kind: 'text' });
    expect(declared.state).toBe(IntentState.DECLARED);
    expect(declared.binding).toBeUndefined();
  });
});

describe('dischargeIntent', () => {
  /**
   * A verdict discharges an intent. Deliberately not a separate call an agent has to remember —
   * that would be the same forgetting problem one layer up.
   */
  it('records WHICH verdict proved it, and at what grade', () => {
    const bound = bindIntent(declareIntent({ id: 'i1', statement: 's', now: NOW }), {
      kind: 'net',
    });
    const proved = dischargeIntent(bound, { verdictId: 'v_7', grade: 'signal', at: 2_000 });
    expect(proved.state).toBe(IntentState.PROVED);
    expect(proved.provenBy).toEqual({ verdictId: 'v_7', grade: 'signal', at: 2_000 });
  });

  /**
   * The grade is kept because a downgrade is the thing worth noticing later: an intent once proved
   * at signal grade and later only at DOM-text grade is a weakening, and without the grade recorded
   * there is nothing to compare against.
   */
  it('keeps the grade so a later weakening is detectable', () => {
    const bound = bindIntent(declareIntent({ id: 'i1', statement: 's', now: NOW }), {
      kind: 'net',
    });
    expect(dischargeIntent(bound, { verdictId: 'v', grade: 'dom', at: 1 }).provenBy?.grade).toBe(
      'dom',
    );
  });

  it('refuses to discharge an intent nothing could have proved', () => {
    // No binding means no predicate was ever satisfied, so a discharge would be a claim with no
    // evidence behind it — exactly the shape this whole feature exists to stop.
    const declared = declareIntent({ id: 'i1', statement: 's', now: NOW });
    expect(dischargeIntent(declared, { verdictId: 'v', grade: 'dom', at: 1 })).toBe(declared);
  });
});

describe('upsertIntent — amendments are append-only', () => {
  /**
   * A long build changes its mind. The ledger keeps the history rather than overwriting, so a
   * NARROWING amendment shows up in the git diff — which is the only real defence against an agent
   * quietly rewriting intent to match what it can already prove.
   */
  it('keeps the previous statement when an intent is amended', () => {
    let file = upsertIntent(
      emptyIntentFile(),
      declareIntent({ id: 'i1', statement: 'first', now: 1 }),
    );
    file = upsertIntent(file, declareIntent({ id: 'i1', statement: 'second', now: 2 }));
    const entry = file.intents['i1'];
    expect(entry?.statement).toBe('second');
    expect(entry?.amended).toEqual([{ statement: 'first', at: 1 }]);
  });

  it('does not record an amendment when nothing changed', () => {
    let file = upsertIntent(
      emptyIntentFile(),
      declareIntent({ id: 'i1', statement: 'same', now: 1 }),
    );
    file = upsertIntent(file, declareIntent({ id: 'i1', statement: 'same', now: 2 }));
    expect(file.intents['i1']?.amended).toBeUndefined();
  });

  it('keeps other intents untouched', () => {
    let file = upsertIntent(emptyIntentFile(), declareIntent({ id: 'a', statement: 'A', now: 1 }));
    file = upsertIntent(file, declareIntent({ id: 'b', statement: 'B', now: 2 }));
    expect(Object.keys(file.intents).sort()).toEqual(['a', 'b']);
  });
});

describe('openIntents', () => {
  it('is everything not yet proved', () => {
    let file = emptyIntentFile();
    file = upsertIntent(file, declareIntent({ id: 'a', statement: 'A', now: 1 }));
    file = upsertIntent(
      file,
      bindIntent(declareIntent({ id: 'b', statement: 'B', now: 1 }), { kind: 'text' }),
    );
    file = upsertIntent(
      file,
      dischargeIntent(
        bindIntent(declareIntent({ id: 'c', statement: 'C', now: 1 }), { kind: 'net' }),
        {
          verdictId: 'v',
          grade: 'net',
          at: 2,
        },
      ),
    );
    expect(
      openIntents(file)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  /**
   * An intent that stays DECLARED and never becomes BOUND is not a failure of the agent — it is the
   * most interesting row in the ledger. Something was meant that nothing can currently prove.
   */
  it('includes a declared-but-unbound intent, because that is the interesting one', () => {
    const file = upsertIntent(
      emptyIntentFile(),
      declareIntent({ id: 'a', statement: 'A', now: 1 }),
    );
    expect(openIntents(file)).toHaveLength(1);
    expect(openIntents(file)[0]?.state).toBe(IntentState.DECLARED);
  });

  it('is empty for an empty ledger', () => {
    expect(openIntents(emptyIntentFile())).toEqual([]);
  });
});

describe('the on-disk file', () => {
  it('is versioned, so a later shape change is not a silent misread', () => {
    expect(emptyIntentFile().version).toBe(INTENT_FILE_VERSION);
  });

  it('parses a well-formed file', () => {
    const file = upsertIntent(
      emptyIntentFile(),
      declareIntent({ id: 'a', statement: 'A', now: 1 }),
    );
    expect(IntentFileSchema.safeParse(file).success).toBe(true);
  });

  it('rejects a malformed one rather than half-reading it', () => {
    expect(IntentFileSchema.safeParse({ version: 1, intents: { a: {} } }).success).toBe(false);
    expect(IntentFileSchema.safeParse({ intents: {} }).success).toBe(false);
    expect(IntentFileSchema.safeParse('nonsense').success).toBe(false);
  });
});
