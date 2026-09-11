import { describe, expect, it } from 'vitest';
import {
  RUN_ESTABLISHED_CAP,
  buildRunContext,
  foldEstablished,
  foldProven,
  remainingFor,
} from './run-context.js';
import { NO_EDITS_OBSERVED } from './edit-epoch.js';
import { Verified } from './verified-constants.js';
import { IntentState, type Intent } from './intent.js';

/**
 * What this run has established, so an agent whose own copy is gone does not rediscover it.
 *
 * Verification is multi-step and the only thing holding the thread together is the agent's context
 * window. When that compacts, or the turn ends, or a sub-agent takes over, the thread is gone and
 * the work restarts. Reticle's copy does not degrade at the same moment, which is the entire reason
 * it can answer: it is not a competing memory, it is the ground truth compaction destroyed.
 *
 * Two rules keep it from becoming the thing it prevents:
 *
 * **It must shrink, not grow.** Re-establishing a subject REPLACES rather than appends, and both
 * blocks are capped by a stated number.
 *
 * **Memory that can be wrong is worse than no memory.** A fact from a replaced document, or from
 * before the last source edit, is precisely the false-green mechanism this product exists to
 * prevent, so it is dropped rather than presented as current.
 */

const fact = (key: string, text: string, doc?: string, epoch?: number) => ({
  key,
  fact: text,
  doc,
  epoch,
});

describe('foldEstablished', () => {
  it('keeps a fact that is still current', () => {
    const out = foldEstablished([], [fact('e12', 'e12 is the Send button', 'd3')], 'd3', undefined);
    expect(out).toHaveLength(1);
    expect(out[0]?.fact).toBe('e12 is the Send button');
  });

  it('SUPERSEDES rather than appends when the same subject is re-established', () => {
    const first = foldEstablished(
      [],
      [fact('e12', 'e12 is the Send button', 'd3')],
      'd3',
      undefined,
    );
    const out = foldEstablished(
      first,
      [fact('e12', 'e12 is the Submit button', 'd3')],
      'd3',
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.fact).toBe('e12 is the Submit button');
  });

  /**
   * The rule that makes this safe to trust at all. A fact established under a document that has
   * since been replaced is not stale-ish or probably-fine: it describes a page that no longer
   * exists, and citing it is the false green this product exists to catch.
   */
  it('DROPS every fact established under a replaced document', () => {
    const before = foldEstablished([], [fact('e12', 'e12 is the Send button', 'd3')], 'd3', 1);
    expect(foldEstablished(before, [], 'd4', 1)).toEqual([]);
  });

  /**
   * Same argument one layer in. A hot update swaps modules inside the SAME document, so the document
   * id never moves, and every fact about the code that was replaced survives unless the epoch is
   * checked too.
   */
  it('DROPS every fact established under a pre-edit epoch', () => {
    const before = foldEstablished([], [fact('e12', 'e12 is the Send button', 'd3', 1)], 'd3', 1);
    expect(foldEstablished(before, [], 'd3', 2)).toEqual([]);
  });

  it('keeps facts from the current document while dropping the superseded ones', () => {
    const mixed = [fact('a', 'a is old', 'd3'), fact('b', 'b is current', 'd4')];
    const out = foldEstablished(mixed, [], 'd4', undefined);
    expect(out.map((f) => f.key)).toEqual(['b']);
  });

  it('caps the set at a stated number, keeping the most recent', () => {
    const many = Array.from({ length: RUN_ESTABLISHED_CAP + 5 }, (_, i) =>
      fact(`k${String(i)}`, `fact ${String(i)}`, 'd3'),
    );
    const out = foldEstablished([], many, 'd3', undefined);
    expect(out).toHaveLength(RUN_ESTABLISHED_CAP);
    expect(out.at(-1)?.key).toBe(`k${String(RUN_ESTABLISHED_CAP + 4)}`);
  });

  /**
   * An unstamped fact predates document identity. It is kept for the same reason unstamped EVIDENCE
   * is treated as current: an older SDK stamps nothing, and dropping its facts would make the answer
   * silently empty rather than honestly smaller.
   */
  it('keeps an unstamped fact rather than dropping it as foreign', () => {
    expect(foldEstablished([], [fact('e1', 'no document known')], 'd3', 4)).toHaveLength(1);
  });

  it('keeps a fact from a page where no edit was ever observed', () => {
    const kept = foldEstablished(
      [],
      [fact('e1', 'e1 is the Send button', 'd3', NO_EDITS_OBSERVED)],
      'd3',
      NO_EDITS_OBSERVED,
    );
    expect(kept).toHaveLength(1);
  });
});

describe('foldProven', () => {
  const proof = (claim: string, doc?: string, epoch?: number) => ({
    claim,
    verified: Verified.YES,
    doc,
    epoch,
  });

  it('keeps what a verdict proved, so a forgotten proof is not re-proved or assumed', () => {
    const out = foldProven([], [proof('badge reads checked in', 'd3')], 'd3', undefined);
    expect(out).toEqual([
      { claim: 'badge reads checked in', verified: Verified.YES, doc: 'd3', epoch: undefined },
    ]);
  });

  it('supersedes when the same claim is proved twice', () => {
    const first = foldProven([], [proof('badge reads checked in', 'd3')], 'd3', undefined);
    const out = foldProven(
      first,
      [{ claim: 'badge reads checked in', verified: Verified.NO, doc: 'd3' }],
      'd3',
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.verified).toBe(Verified.NO);
  });

  it('drops a proof taken under a replaced document or a pre-edit epoch', () => {
    const before = foldProven([], [proof('checkout works', 'd3', 1)], 'd3', 1);
    expect(foldProven(before, [], 'd4', 1)).toEqual([]);
    expect(foldProven(before, [], 'd3', 2)).toEqual([]);
  });
});

describe('the fold supersedes within one batch, not only against a prior one', () => {
  /**
   * `buildRunContext` folds against an EMPTY prior set, so if superseding only ever applied to the
   * existing rows it would never apply at all — and the contract this envelope advertises is that
   * `key` is the subject and re-observing it replaces rather than appends.
   *
   * Observed on a real driven session before this was fixed: the same ref twice, the same proven
   * claim three times. Duplicates in the one payload whose entire purpose is a CHEAP context
   * restore, and a report that contradicts its own declared schema.
   */
  it('keeps one row per subject when a batch observes the same subject twice', () => {
    const out = foldEstablished(
      [],
      [fact('e4', 'e4 is the Save button', 'd1'), fact('e4', 'e4 is the Submit button', 'd1')],
      'd1',
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.fact).toBe('e4 is the Submit button');
  });

  it('keeps the LAST reading, because the newest observation is the true one', () => {
    const out = foldEstablished(
      [],
      [fact('a', 'first', 'd1'), fact('b', 'other', 'd1'), fact('a', 'second', 'd1')],
      'd1',
      undefined,
    );
    expect(out.map((f) => f.key)).toEqual(['b', 'a']);
    expect(out.find((f) => 'a' === f.key)?.fact).toBe('second');
  });

  it('still supersedes an existing row, which is what it already did', () => {
    // The behaviour that worked stays working — this is a fold that gained a case, not a rewrite.
    const out = foldEstablished(
      [fact('e4', 'old', 'd1')],
      [fact('e4', 'new', 'd1')],
      'd1',
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.fact).toBe('new');
  });
});

describe('remainingFor', () => {
  const intent = (id: string, state: Intent['state'], statement: string): Intent => ({
    id,
    statement,
    state,
    declaredAt: 0,
  });

  it('lists what no verdict has discharged yet', () => {
    const out = remainingFor([
      intent('i1', IntentState.BOUND, 'the badge should read checked in'),
      intent('i2', IntentState.PROVED, 'the form submits'),
    ]);
    expect(out).toEqual(['the badge should read checked in']);
  });

  it('includes a declared intent, which is undischarged by definition', () => {
    expect(remainingFor([intent('i1', IntentState.DECLARED, 'checkout works')])).toEqual([
      'checkout works',
    ]);
  });

  /**
   * `remaining` is DERIVED, never inferred. It reports which declared bindings are undischarged, a
   * fact about the ledger, and never a guess at what the agent means to do next. A tool that
   * predicts intent is inventing evidence, which is the one thing this must not do.
   */
  it('is empty when everything declared has been proved', () => {
    expect(remainingFor([intent('i1', IntentState.PROVED, 'done')])).toEqual([]);
    expect(remainingFor([])).toEqual([]);
  });
});

describe('buildRunContext', () => {
  it('reports the step, what is established, what is proven, and what is outstanding', () => {
    const context = buildRunContext({
      step: 6,
      intents: [
        { id: 'i1', statement: 'badge reads checked in', state: IntentState.BOUND, declaredAt: 0 },
      ],
      established: [fact('e12', 'e12 is the Send button', 'd3')],
      proven: [{ claim: 'the row disappears', verified: Verified.YES, doc: 'd3' }],
      currentDocumentId: 'd3',
      currentEditEpoch: undefined,
    });
    expect(context.step).toBe(6);
    expect(context.established).toHaveLength(1);
    expect(context.proven).toHaveLength(1);
    expect(context.remaining).toEqual(['badge reads checked in']);
  });

  /**
   * An empty answer is the honest one for a run that has established nothing. The push version of
   * this returned `undefined` so an empty block would not ride on every response; a PULL is asked
   * for, and "nothing yet" is the answer the asker needs rather than silence.
   */
  it('answers a fresh run with an honest empty context rather than inventing one', () => {
    const context = buildRunContext({
      step: 0,
      intents: [],
      established: [],
      proven: [],
      currentDocumentId: 'd1',
      currentEditEpoch: undefined,
    });
    expect(context).toEqual({ step: 0, established: [], proven: [], remaining: [] });
  });
});
