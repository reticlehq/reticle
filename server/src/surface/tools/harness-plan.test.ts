import { describe, expect, it } from 'vitest';
import { buildHarnessPlan, planAsText, PlanStepKind } from './harness-plan.js';
import type { DomainModel } from '@/judgement/domain/domain-model.js';

/**
 * The plan is the deterministic half of a drive: read out of `.reticle`, with no browser, no model
 * and no source code. These tests are about the two properties that make it worth having — that
 * anything already recorded is replayed rather than re-driven, and that every step carries the
 * project's own statement of what it is FOR.
 */

const model = (over: Partial<DomainModel> = {}): DomainModel => ({
  flowCount: 0,
  flows: [],
  declared: { testids: 0, signals: [], stores: [] },
  coverage: { asserted: 0, presenceOnly: 0, assertionFree: 0 },
  gaps: { unassertedFlows: [], declaredUntestedSignals: [], declaredUntestedTestids: [] },
  riskRanked: [],
  summary: '',
  ...over,
});

const flow = (name: string, mustHold?: string) => ({
  name,
  steps: 3,
  grade: mustHold === undefined ? 'assertion-free' : 'asserted',
  asserts: mustHold !== undefined,
  ...(mustHold === undefined ? {} : { mustHold }),
  signals: [],
  testids: [],
});

describe('building a plan from what the project already knows', () => {
  it('says plainly when there is nothing to go on', () => {
    const plan = buildHarnessPlan(model());
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toContain('no plan to follow');
  });

  /**
   * The whole economics. A recorded journey replays deterministically for a few hundred tokens;
   * re-driving it pays a model to rediscover something already on disk.
   */
  it('replays what is recorded rather than re-driving it', () => {
    const plan = buildHarnessPlan(model({ flows: [flow('sign-in', 'signal auth:ok')] }));
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.kind).toBe(PlanStepKind.REPLAY);
    expect(plan.steps[0]?.target).toBe('sign-in');
  });

  it('carries the consequence that must hold, as the reason for the step', () => {
    const plan = buildHarnessPlan(model({ flows: [flow('checkout', 'net POST /api/order')] }));
    expect(plan.steps[0]?.why).toContain('net POST /api/order');
  });

  /** A flow that asserts nothing is still replayed, and the plan refuses to call it coverage. */
  it('admits when a recorded flow proves nothing', () => {
    const plan = buildHarnessPlan(model({ flows: [flow('clicks-around')] }));
    expect(plan.steps[0]?.why).toContain('asserts no consequence');
  });

  it('drives declared intent that no flow has ever asserted', () => {
    const plan = buildHarnessPlan(
      model({
        gaps: {
          unassertedFlows: [],
          declaredUntestedSignals: ['order:placed'],
          declaredUntestedTestids: [],
        },
      }),
    );
    expect(plan.steps[0]?.kind).toBe(PlanStepKind.DRIVE);
    expect(plan.steps[0]?.why).toContain('order:placed');
  });

  /**
   * Replays FIRST, always. They are the cheap half, and a regression they catch is caught for a few
   * hundred tokens instead of a few hundred thousand.
   */
  it('puts every replay before every drive', () => {
    const plan = buildHarnessPlan(
      model({
        flows: [flow('sign-in', 'signal auth:ok')],
        gaps: {
          unassertedFlows: [],
          declaredUntestedSignals: ['order:placed'],
          declaredUntestedTestids: [],
        },
      }),
    );
    expect(plan.steps.map((s) => s.kind)).toEqual([PlanStepKind.REPLAY, PlanStepKind.DRIVE]);
  });

  it('replays the riskiest flow first when there is history to rank by', () => {
    const plan = buildHarnessPlan(
      model({
        flows: [flow('a', 'x'), flow('b', 'y'), flow('c', 'z')],
        riskRanked: ['c', 'a'],
      }),
    );
    // Ranked names first, in rank order; anything unranked keeps its place behind them.
    expect(plan.steps.map((s) => s.target)).toEqual(['c', 'a', 'b']);
  });

  it('prefers a declared signal over a declared control', () => {
    const plan = buildHarnessPlan(
      model({
        gaps: {
          unassertedFlows: [],
          declaredUntestedSignals: ['order:placed'],
          declaredUntestedTestids: ['submit-btn'],
        },
      }),
    );
    expect(plan.steps.map((s) => s.target)).toEqual(['order:placed', 'submit-btn']);
  });

  /** A plan longer than the step budget is a list, not a plan. */
  it('caps how many untested declarations become steps', () => {
    const many = Array.from({ length: 40 }, (_, i) => `sig-${String(i)}`);
    const plan = buildHarnessPlan(
      model({
        gaps: { unassertedFlows: [], declaredUntestedSignals: many, declaredUntestedTestids: [] },
      }),
    );
    expect(plan.steps.length).toBeLessThanOrEqual(12);
  });
});

describe('the plan as the model reads it', () => {
  it('leads with intent rather than identifiers', () => {
    const text = planAsText(
      buildHarnessPlan(model({ flows: [flow('sign-in', 'signal auth:ok')] })),
    );
    expect(text).toContain('signal auth:ok');
    expect(text).toContain('[replay]');
  });

  /** Said out loud, because it is the rule this harness kept breaking. */
  it('says the plan came from .reticle rather than the source', () => {
    const text = planAsText(buildHarnessPlan(model({ flows: [flow('a', 'x')] })));
    expect(text).toContain('.reticle');
    expect(text).toContain('not from the source');
  });

  it('says so when there is no plan', () => {
    expect(planAsText(buildHarnessPlan(model()))).toContain('none');
  });
});

/**
 * An uncapped plan spends more than it saves.
 *
 * Seventy-four recorded flows produced a seventy-four-step plan, which went into the tool result
 * AND the standing instruction — thousands of tokens a turn, listing work the drive had no budget
 * to do. The whole argument for reading `.reticle` first is spending less.
 */
describe('a plan on a project with a lot of history', () => {
  const many = (n: number, withMustHold: boolean) =>
    Array.from({ length: n }, (_, i) =>
      flow(`f-${String(i)}`, withMustHold ? `signal s:${String(i)}` : undefined),
    );

  it('caps how many recorded journeys it lists', () => {
    const plan = buildHarnessPlan(model({ flows: many(74, false) }));
    expect(plan.steps.length).toBeLessThanOrEqual(15);
  });

  /** Counted over everything, listed up to the cap — a shorter listing is not a smaller analysis. */
  it('still counts every flow it did not list', () => {
    const plan = buildHarnessPlan(model({ flows: many(74, false) }));
    expect(plan.summary).toContain('74 recorded');
    expect(plan.summary).toContain('omitting');
  });

  /** Proving nothing is the first thing to give up when the plan has to be cut. */
  it('keeps the flows that assert something over the ones that do not', () => {
    const plan = buildHarnessPlan(
      model({ flows: [...many(20, false), flow('the-one-that-matters', 'signal order:placed')] }),
    );
    expect(plan.steps[0]?.target).toBe('the-one-that-matters');
  });
});

/**
 * The names a drive can CLAIM, which is a different question from what it should do.
 *
 * A declaration only survives into a saved flow if it names something: `signal "order:placed"`
 * records and replays, "some signal fires" is dropped at record time and leaves a flow that passes
 * whatever the feature does. Measured on a real dashboard: 0 of 22 steps across 16 machine-driven
 * flows carried a single expectation, because every consequence on offer was unbound.
 */
describe('the vocabulary a drive is given to claim with', () => {
  it('offers the declared signals nobody has tested first', () => {
    const plan = buildHarnessPlan(
      model({
        declared: { testids: 0, signals: ['a:fired', 'b:fired'], stores: [] },
        gaps: {
          unassertedFlows: [],
          declaredUntestedSignals: ['b:fired'],
          declaredUntestedTestids: [],
        },
      }),
    );
    expect(plan.vocabulary[0]).toBe('b:fired');
    expect(plan.vocabulary).toContain('a:fired');
  });

  /** Most apps declare nothing. A vocabulary that only reads declarations is empty where it matters. */
  it('falls back to the signals saved flows already assert', () => {
    const asserted = { ...flow('checkout', 'signal order:placed'), signals: ['order:placed'] };
    const plan = buildHarnessPlan(model({ flows: [asserted] }));
    expect(plan.vocabulary).toEqual(['order:placed']);
  });

  it('says the same name once, however many flows assert it', () => {
    const a = { ...flow('one', 'x'), signals: ['order:placed'] };
    const b = { ...flow('two', 'y'), signals: ['order:placed'] };
    expect(buildHarnessPlan(model({ flows: [a, b] })).vocabulary).toEqual(['order:placed']);
  });

  it('is empty, rather than absent, for a project that knows nothing yet', () => {
    expect(buildHarnessPlan(model()).vocabulary).toEqual([]);
  });
});
