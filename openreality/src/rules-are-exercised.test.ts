import { describe, expect, it } from 'vitest';
import {
  canProve,
  channelsMissingFor,
  ChannelId,
  citeVerdict,
  evidenceIsAdmissible,
  Grade,
  Independence,
  invalidationBetween,
  moreAuthoritative,
  outcomeOf,
  Profile,
  ProvenanceClass,
  RunOutcome,
  standingVerdicts,
  Surface,
  Verdict,
  type ChannelDescriptor,
  type Evidence,
  type SubjectRef,
  type VerdictRecord,
  type VerificationRun,
} from './index.js';

/**
 * The rules this specification publishes as code, and nothing had ever called.
 *
 * Eight exported functions had **zero** uses anywhere in this repository: not by `adjudicate`,
 * not by the binding, not by a test. They are not dead code -- this package exists so that
 * somebody outside it can implement the protocol, and a rule they are meant to call is doing its
 * job when we never call it ourselves. But a published rule that has never been executed is a
 * rule nobody has checked, and several of these encode the subtlest parts of the specification:
 * whether evidence survives a navigation, which of two observations outranks the other, whether
 * a run's outcome is a pass.
 *
 * This is the sixth instance of one shape in this release, and the largest. `impeaching`,
 * `predicate`, `Ground`, `Handle` and `describe` were each defined, deferred to somebody, and
 * reached by nobody; the first three made a clause of the adjudicator unreachable and the fourth
 * made a method unimplementable from the published contract. These eight are the same shape with
 * the mildest consequence, which is exactly why they lasted longest.
 *
 * Each test pins the DOCUMENTED behaviour, including the edge the prose calls out.
 */

const subject = (over: Partial<SubjectRef> = {}): SubjectRef => ({
  surface: Surface.WEB,
  instance: 'doc_1',
  locator: 'https://host/checkout',
  ...over,
});

/**
 * Built without a cast, deliberately.
 *
 * The first version of this fixture invented the shape -- `id`, `observations`, a bare
 * `provenance.class` -- and an `as Evidence` cast made every test pass. `tsc` rejected it, which
 * is the only reason the fixture is right: a cast in a test fixture is a false green waiting to
 * be believed, and this one was mine.
 */
const evidence = (cls: ProvenanceClass = ProvenanceClass.OBSERVED, source = 'probe'): Evidence => ({
  observation: { id: `o-${source}`, window: 'w1', channel: ChannelId.NET, at: 1, summary: 'net' },
  provenance: { class: cls, source, method: 'read', subject: subject(), at: 1 },
  independence: Independence.INDEPENDENT,
  grade: Grade.CONSEQUENCE,
});

const verdict = (over: Partial<VerdictRecord> = {}): VerdictRecord =>
  ({
    id: 'v1',
    claim: 'it happened',
    window: 'w1',
    verdict: Verdict.YES,
    reasons: [],
    evidence: [],
    anomalies: [],
    at: 1,
    ...over,
  }) as VerdictRecord;

const run = (verdicts: readonly VerdictRecord[]): VerificationRun =>
  ({ id: 'r1', subject: subject(), verdicts, startedAt: 0, endedAt: 1 }) as VerificationRun;

describe('a subject identity decides what evidence still counts', () => {
  it('admits evidence only from the same instance', () => {
    // The rule behind `evidence-superseded`: a document replaced by a navigation takes its
    // evidence with it, and reporting the old observations is a statement about a page that is
    // no longer there.
    expect(evidenceIsAdmissible(subject(), subject())).toBe(true);
    expect(evidenceIsAdmissible(subject(), subject({ instance: 'doc_2' }))).toBe(false);
  });

  it('names WHICH invalidation happened, because the two mean different things', () => {
    // `instance` is "the thing was replaced"; `epoch` is "only the code under it changed". The
    // first says look again, the second says this evidence is about the old code.
    expect(invalidationBetween(subject(), subject())).toBeUndefined();
    expect(invalidationBetween(subject(), subject({ instance: 'doc_2' }))).toEqual({
      kind: 'instance',
      from: 'doc_1',
      to: 'doc_2',
    });
    expect(invalidationBetween(subject({ epoch: 1 }), subject({ epoch: 2 }))).toEqual({
      kind: 'epoch',
      from: '1',
      to: '2',
    });
  });

  it('reports no epoch change when either side does not know its epoch', () => {
    // The edge the prose implies and the code makes explicit: an unknown epoch is not a
    // different epoch, and inventing an invalidation would discard good evidence.
    expect(invalidationBetween(subject({ epoch: 1 }), subject())).toBeUndefined();
    expect(invalidationBetween(subject(), subject({ epoch: 2 }))).toBeUndefined();
  });
});

describe('what a set of channels can buy', () => {
  const consequence: ChannelDescriptor = {
    id: ChannelId.NET,
    independence: Independence.INDEPENDENT,
    grade: Grade.CONSEQUENCE,
  };
  const presence: ChannelDescriptor = {
    id: ChannelId.UI,
    independence: Independence.ACTUATION_DERIVED,
    grade: Grade.PRESENCE,
  };

  it('can prove only when some channel reaches consequence grade', () => {
    expect(canProve([consequence, presence])).toBe(true);
    expect(canProve([presence])).toBe(false);
    expect(canProve([])).toBe(false);
  });

  it('names the channels a claimed profile requires and the implementation lacks', () => {
    // The handshake check: an implementation that claims a profile it cannot serve is scored on
    // evidence it never had, which is worse than one that claims less.
    //
    // The first draft of this test asserted that `surface` needs no `net`, on the assumption
    // that a profile called "surface" is the narrow one. It is the WIDEST: the profiles nest,
    // and `surface` requires everything `effect` and `in-realm` do plus `ui`. The test caught
    // the guess, which is the argument for writing one against a rule nobody had executed.
    expect(channelsMissingFor(Profile.SURFACE, [presence])).toContain(ChannelId.NET);
    expect(channelsMissingFor(Profile.EFFECT, [consequence, presence])).toEqual([ChannelId.LOG]);
    expect(channelsMissingFor(Profile.EFFECT, [])).toEqual([ChannelId.NET, ChannelId.LOG]);
  });

  it('nests: anything the narrower profile needs, the wider one needs too', () => {
    // Stated nowhere as a test and relied on by `profileFromChannels`, which walks the profiles
    // in order and stops at the first one the declaration cannot satisfy. If they did not nest,
    // that walk would earn a wide profile while skipping a narrow one.
    const none: ChannelDescriptor[] = [];
    const effect = channelsMissingFor(Profile.EFFECT, none);
    const inRealm = channelsMissingFor(Profile.IN_REALM, none);
    const surface = channelsMissingFor(Profile.SURFACE, none);
    for (const c of effect) expect(inRealm).toContain(c);
    for (const c of inRealm) expect(surface).toContain(c);
  });
});

describe('which of two observations outranks the other', () => {
  it('prefers the more authoritative provenance and keeps the first on a tie', () => {
    const authoritative = evidence(ProvenanceClass.AUTHORITATIVE, 'a');
    const learned = evidence(ProvenanceClass.LEARNED, 'l');
    expect(moreAuthoritative(learned, authoritative).provenance.source).toBe('a');
    expect(moreAuthoritative(authoritative, learned).provenance.source).toBe('a');
    // Ties return the FIRST, which is the documented behaviour and the one a caller folding a
    // list depends on: without it, folding the same evidence twice could change the answer.
    const x = evidence(ProvenanceClass.OBSERVED, 'x');
    const y = evidence(ProvenanceClass.OBSERVED, 'y');
    expect(moreAuthoritative(x, y).provenance.source).toBe('x');
  });
});

describe('what a whole run amounts to', () => {
  it('is PARTIAL when something was proved and something was disproved', () => {
    // The value that must not collapse into either neighbour: a run with one of each is not a
    // pass and is not a failure, and reporting it as either loses the half that matters.
    expect(outcomeOf(run([verdict(), verdict({ id: 'v2', verdict: Verdict.NO })]))).toBe(
      RunOutcome.PARTIAL,
    );
    expect(outcomeOf(run([verdict()]))).toBe(RunOutcome.PASS);
    expect(outcomeOf(run([verdict({ verdict: Verdict.NO })]))).toBe(RunOutcome.FAIL);
  });

  it('is UNKNOWN when nothing was proved either way, including an empty run', () => {
    // An empty run reporting PASS is the false green this whole model exists to refuse.
    expect(outcomeOf(run([]))).toBe(RunOutcome.UNKNOWN);
    expect(outcomeOf(run([verdict({ verdict: Verdict.UNKNOWN })]))).toBe(RunOutcome.UNKNOWN);
    expect(outcomeOf(run([verdict({ verdict: Verdict.NO_FAULT })]))).toBe(RunOutcome.UNKNOWN);
  });

  it('counts only the verdicts no correction has replaced', () => {
    // A revision never edits the record it replaces, so a reader who does not filter sees both
    // the first answer and its correction and counts the run twice.
    const first = verdict({ id: 'v1', verdict: Verdict.NO });
    const corrected = verdict({
      id: 'v2',
      verdict: Verdict.YES,
      supersedes: citeVerdict('r1', 'v1'),
    });
    const standing = standingVerdicts(run([first, corrected]));
    expect(standing.map((v) => v.id)).toEqual(['v2']);
  });
});
