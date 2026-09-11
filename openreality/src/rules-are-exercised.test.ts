import { describe, expect, it } from 'vitest';
import {
  canProve,
  canSupportConsequence,
  closedCleanly,
  CloseCondition,
  disagreementCanConvict,
  impeachingSpots,
  isImpeached,
  BlindSpotKind,
  matches,
  render,
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
  type BlindSpot,
  type Coverage,
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

describe('what evidence is allowed to buy a proof', () => {
  it('needs independence AND consequence grade AND a provenance that is not learned', () => {
    // All three, and the third is the fence around a model's opinion: a learned belief may be
    // right and may not be evidence that something happened.
    expect(canSupportConsequence(evidence())).toBe(true);
    expect(canSupportConsequence(evidence(ProvenanceClass.LEARNED))).toBe(false);
    expect(
      canSupportConsequence({ ...evidence(), independence: Independence.ACTUATION_DERIVED }),
    ).toBe(false);
    expect(canSupportConsequence({ ...evidence(), grade: Grade.PRESENCE })).toBe(false);
  });
});

describe('when two channels disagreeing is allowed to convict', () => {
  const independent = {
    id: ChannelId.NET,
    independence: Independence.INDEPENDENT,
    grade: Grade.CONSEQUENCE,
  };
  const derived = {
    id: ChannelId.UI,
    independence: Independence.ACTUATION_DERIVED,
    grade: Grade.PRESENCE,
  };

  it('requires at least one independent side, in either position', () => {
    // The subject contradicting its own reporting is real and is not proof that anything
    // failed. Both orders are asserted because a rule that holds one way round and not the
    // other would convict or acquit depending on argument order.
    expect(disagreementCanConvict(independent, derived)).toBe(true);
    expect(disagreementCanConvict(derived, independent)).toBe(true);
    expect(disagreementCanConvict(independent, independent)).toBe(true);
    expect(disagreementCanConvict(derived, derived)).toBe(false);
  });
});

describe('when a window counts as closed', () => {
  const open = {
    id: 'w1',
    subject: subject(),
    openedAt: 0,
    budgetMs: 100,
    closes: CloseCondition.QUIESCENCE,
  };

  it('needs a close time, a close reason, and a reason that is not the budget running out', () => {
    expect(closedCleanly({ ...open, closedAt: 10, closedBy: CloseCondition.QUIESCENCE })).toBe(
      true,
    );
    // The one that matters: spending the whole budget is the verifier giving up, and a verdict
    // resting on it is a statement about our patience rather than about the application.
    expect(
      closedCleanly({ ...open, closedAt: 10, closedBy: CloseCondition.BUDGET_EXHAUSTED }),
    ).toBe(false);
    expect(closedCleanly(open)).toBe(false);
    expect(closedCleanly({ ...open, closedAt: 10 })).toBe(false);
  });
});

describe('which blind spots bear on a claim', () => {
  const onNet = {
    kind: BlindSpotKind.STILL_IN_FLIGHT,
    channel: ChannelId.NET,
    detail: 'a request had not settled',
    impeaching: false,
  };
  const unflagged = {
    kind: BlindSpotKind.REDACTED,
    detail: 'a secret was withheld',
    impeaching: false,
  };
  const coverage = (blindSpots: readonly BlindSpot[]): Coverage => ({
    window: 'w1',
    observed: [],
    blindSpots: [...blindSpots],
  });

  it('impeaches on a channel the claim reads, even when the realm did not say so', () => {
    // The half that was missing while clause 6 was unreachable: a realm cannot judge relevance
    // because it does not see the claim, so the match happens here.
    expect(impeachingSpots(coverage([onNet]), [ChannelId.NET])).toHaveLength(1);
    expect(impeachingSpots(coverage([onNet]), [ChannelId.UI])).toHaveLength(0);
  });

  it('impeaches on the flag alone when the spot names no channel', () => {
    // A statement about the observation as a whole: only the implementation knows what it bears
    // on, so the flag is the only thing that can speak for it.
    expect(impeachingSpots(coverage([unflagged]), [ChannelId.NET])).toHaveLength(0);
    expect(
      impeachingSpots(coverage([{ ...unflagged, impeaching: true }]), [ChannelId.NET]),
    ).toHaveLength(1);
  });

  it('isImpeached reads the flag only, which is why it is the weaker form', () => {
    expect(isImpeached(coverage([onNet]))).toBe(false);
    expect(isImpeached(coverage([{ ...onNet, impeaching: true }]))).toBe(true);
  });
});

describe('how a predicate selects observations', () => {
  const observation = {
    id: 'o1',
    window: 'w1',
    channel: ChannelId.NET,
    at: 1,
    summary: 'net.request',
    value: { url: 'https://host/api/login' },
  };

  it('matches on channel, exact summary, and a substring of the rendered value', () => {
    const rendered = render(observation.value);
    expect(matches({ channel: ChannelId.NET }, observation, rendered)).toBe(true);
    expect(matches({ channel: ChannelId.UI }, observation, rendered)).toBe(false);
    // Exact, never a pattern: a regular expression over `summary` would be a predicate language
    // arriving through the back door.
    expect(matches({ channel: ChannelId.NET, summary: 'net.req' }, observation, rendered)).toBe(
      false,
    );
    expect(
      matches({ channel: ChannelId.NET, valueContains: '/api/login' }, observation, rendered),
    ).toBe(true);
  });

  it('renders a string as itself and anything unserialisable as empty', () => {
    // Empty rather than a guess: an unmatched value is honest, and a rendering that invented
    // something would make `valueContains` match things that are not there.
    expect(render('already text')).toBe('already text');
    expect(render({ a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(render(cyclic)).toBe('');
  });
});
