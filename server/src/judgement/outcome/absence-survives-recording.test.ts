/**
 * A recorded ABSENCE must still be an absence when the flow replays.
 *
 * Reported from the field (#988): `record{stop}` turned an element assertion carrying `absent: true`
 * into an element-PRESENCE expectation. The agent proved "the error banner is gone", the saved flow
 * asserts "the error banner is there", and the replay of that flow passes when the app is broken and
 * fails when it works. A dropped assertion leaves a flow that cannot go red; a REVERSED one leaves a
 * flow that is red about the wrong thing and green about the regression — strictly worse, because it
 * wears the `presence-only` grade that says somebody checked.
 *
 * The reversal needed three separate things to stay wrong at once, which is why this test walks all
 * three rather than unit-testing the first: `FlowExpect.element` had nowhere to put the polarity,
 * `predicateToExpect` therefore dropped it, and both the step runner and `successToPredicate` then
 * read the surviving locator as something to find.
 *
 * The negative direction also has a loss rule the positive direction does not. Dropping a narrowing
 * field from a PRESENCE claim weakens it; dropping the same field from an ABSENCE claim STRENGTHENS
 * it — "no Remove button in row 2" becomes "no Remove button on the page", which is a claim the
 * agent never made and a false red. So a negative predicate is carried only when it can be carried
 * whole, and refused otherwise.
 */

import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  ElementState,
  FLOW_FILE_VERSION,
  PredicateKind,
  ReticleCommand,
  ReticleTool,
  asRef,
  asString,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { enforcedOnReplay, predicateToExpect } from './predicate-to-expect.js';
import { successToPredicate } from '@/language/flows/flow-success.js';
import { captureAct } from '@/language/flows/replay.js';
import { replayFlow } from '@/language/flows/flow-replay.js';
import type { FlowReplaySession } from '@/language/flows/flow-replay.js';
import type { RecordedStep } from '@/language/flows/recording/tape/recordings.js';

const NO_DYNAMIC = new Set<string>();
/** Short, because the interesting case is the one that has to time out before it can fail. */
const FAST_MS = 60;
const BANNER = 'error-banner';
const DISMISS = 'dismiss';

/**
 * The element part of a compiled predicate, wherever it ended up.
 *
 * `absent` compiles to `allOf [settled, element]` on purpose — the same post-settle gate
 * `console.absent` and `text.absent` already use, because a wait-until-true waiter reads "not there
 * yet" on its first poll and would pass before the thing it is watching had even rendered.
 */
function elementPartOf(
  predicate: Predicate | undefined,
): Extract<Predicate, { kind: typeof PredicateKind.ELEMENT }> | undefined {
  if (predicate === undefined) return undefined;
  if (predicate.kind === PredicateKind.ELEMENT) return predicate;
  if (predicate.kind !== PredicateKind.ALL_OF) return undefined;
  for (const part of predicate.predicates) {
    const found = elementPartOf(part);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('an absence an agent proved reaches the saved flow as an absence', () => {
  it('carries absent:true out of the predicate the agent wrote', () => {
    expect(
      predicateToExpect({
        kind: PredicateKind.ELEMENT,
        query: { role: 'alert', name: 'Upload failed' },
        absent: true,
      }),
    ).toEqual({ element: { role: 'alert', name: 'Upload failed', absent: true } });
  });

  it('keeps absent:true through the filter that decides what reaches disk', () => {
    expect(enforcedOnReplay({ element: { testid: BANNER, absent: true } })).toEqual({
      element: { testid: BANNER, absent: true },
    });
  });

  it('compiles the recorded absence back into an absence replay can evaluate', () => {
    const compiled = successToPredicate({ element: { testid: BANNER, absent: true } }, NO_DYNAMIC);
    expect(elementPartOf(compiled)?.absent).toBe(true);
  });

  it('never lets the round trip turn the absence into a presence check', () => {
    // The whole defect in one assertion: express -> filter -> compile back, and read the polarity
    // at the far end. A presence check here is green on exactly the app state the agent proved was
    // broken, and it is graded as if somebody had asserted something.
    const recorded = enforcedOnReplay(
      predicateToExpect({
        kind: PredicateKind.ELEMENT,
        query: { testid: BANNER },
        absent: true,
      }),
    );
    expect(recorded, 'the assertion survived the recording path at all').toBeDefined();
    const back = successToPredicate(recorded ?? {}, NO_DYNAMIC);
    const element = elementPartOf(back);
    expect(element, 'replay is given an element predicate to evaluate').toBeDefined();
    expect(element?.absent, 'and it still says ABSENT, not present').toBe(true);
  });
});

describe('a negative claim that cannot be carried whole is refused, never widened', () => {
  it('records nothing for an absence narrowed by a scope FlowExpect cannot hold', () => {
    // `scope` narrows the search to one row. Keeping only role+name would save "no Remove button
    // anywhere", which is a strictly STRONGER claim than the agent made and fails on a page that is
    // working correctly. Recording nothing leaves the flow honestly assertion-free instead.
    expect(
      predicateToExpect({
        kind: PredicateKind.ELEMENT,
        query: { role: 'button', name: 'Remove', scope: '#row-2' },
        absent: true,
      }),
    ).toBeUndefined();
  });

  it('records nothing for an absence narrowed by an element state', () => {
    // "no DISABLED Save button" is not "no Save button". FlowExpect.element has no state field, so
    // the only faithful options are refusing or inventing, and inventing is the false green.
    expect(
      predicateToExpect({
        kind: PredicateKind.ELEMENT,
        query: { role: 'button', name: 'Save' },
        state: ElementState.DISABLED,
        absent: true,
      }),
    ).toBeUndefined();
  });

  it('records nothing for an absence with no anchor at all', () => {
    expect(
      predicateToExpect({ kind: PredicateKind.ELEMENT, query: {}, absent: true }),
    ).toBeUndefined();
  });
});

describe('the positive direction is left exactly as it was', () => {
  it('still records a presence assertion by testid and by role+name', () => {
    expect(
      predicateToExpect({ kind: PredicateKind.ELEMENT, query: { testid: 'reply-modal' } }),
    ).toEqual({ element: { testid: 'reply-modal' } });
    expect(
      predicateToExpect({
        kind: PredicateKind.ELEMENT,
        query: { role: 'button', name: '0 Clicks' },
      }),
    ).toEqual({ element: { role: 'button', name: '0 Clicks' } });
  });

  it('writes no polarity field for an explicitly positive predicate', () => {
    // `absent: false` IS presence, and a flow file that spells it out twice invites the next reader
    // to wonder which one replay honours. The canonical shape stays the one recorded before this.
    expect(
      predicateToExpect({
        kind: PredicateKind.ELEMENT,
        query: { role: 'button', name: '0 Clicks' },
        absent: false,
      }),
    ).toEqual({ element: { role: 'button', name: '0 Clicks' } });
  });

  it('still drops a scope from a PRESENCE claim, which only weakens it', () => {
    // Unchanged on purpose: the de-scoped-anchor half of #988 is a separate report, and a weaker
    // presence claim is lossy rather than reversed. Pinned so the refusal above cannot quietly
    // spread to the direction it was not reasoned about.
    expect(
      predicateToExpect({
        kind: PredicateKind.ELEMENT,
        query: { role: 'button', name: 'Details', scope: '#row-2' },
      }),
    ).toEqual({ element: { role: 'button', name: 'Details' } });
  });
});

function descriptor(testid: string): ElementDescriptor {
  return { ref: asRef(`e-${testid}`), role: 'button', name: testid, states: [], visible: true };
}

/** A page that answers both the anchor QUERY and the predicate engine's MATCH from one testid set. */
class FakePage implements FlowReplaySession {
  readonly acts: string[] = [];
  constructor(private readonly present: Set<string>) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      const value = asString(args['value']) ?? '';
      return Promise.resolve(this.found('q', value));
    }
    if (name === ReticleCommand.MATCH) {
      const query = args['query'];
      const value =
        'object' === typeof query && null !== query
          ? (asString((query as Record<string, unknown>)['testid']) ?? '')
          : '';
      return Promise.resolve(this.found('m', value));
    }
    if (name === ReticleCommand.ACT) {
      this.acts.push(asString(args['ref']) ?? '');
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  private found(id: string, value: string): CommandResult {
    const elements = this.present.has(value) ? [descriptor(value)] : [];
    return {
      kind: 'command_result',
      id,
      ok: true,
      result: {
        matched: elements.length > 0,
        count: elements.length,
        elements,
        hint: { route: '/', presentTestids: [...this.present], knownEmptyState: false },
      },
    };
  }

  eventsSince(): never[] {
    return [];
  }

  onEvent(): () => void {
    return () => undefined;
  }

  elapsed(): number {
    return 0;
  }
}

function dismissStep(): FlowStep {
  return {
    tool: ReticleTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: DISMISS },
    action: ActionType.CLICK,
    args: {},
    expect: { element: { testid: BANNER, absent: true } },
  };
}

function flowOf(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'dismiss-the-banner', createdAt: 0, steps };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('replaying a recorded absence', () => {
  it('goes RED when the element the agent saw disappear is still there', async () => {
    // The false green in full. Before the fix the saved step read "the banner is present", the
    // banner WAS present because dismiss is broken, and the replay reported the journey fine.
    const page = new FakePage(new Set([DISMISS, BANNER]));
    const steps = await replayFlow(
      page,
      flowOf([dismissStep()]),
      waitForPredicate,
      FAST_MS,
      false,
      noSleep,
    );

    expect(page.acts, 'the action still ran').toContain(`e-${DISMISS}`);
    expect(steps[0]?.ok, 'a banner that never went away is a failed dismissal').toBe(false);
    expect(steps[0]?.drift).toBeDefined();
  });

  it('goes GREEN when the element is gone, which is what was proved live', async () => {
    // The mirror, and the reason the reversal was invisible: before the fix THIS case failed, so a
    // working app produced a red flow and the only fix that looked available was deleting the step.
    const page = new FakePage(new Set([DISMISS]));
    const steps = await replayFlow(
      page,
      flowOf([dismissStep()]),
      waitForPredicate,
      FAST_MS,
      false,
      noSleep,
    );

    expect(steps[0]?.ok).toBe(true);
    expect(steps[0]?.drift).toBeUndefined();
  });

  it('holds inside an act_sequence sub-step too', async () => {
    // The sequence runner has its own copy of the "assert the declared testid is present" check, so
    // the polarity has to be honoured twice or a journey recorded as one sequence keeps the bug.
    const page = new FakePage(new Set([DISMISS, BANNER]));
    const sequence: FlowStep = {
      tool: ReticleTool.ACT_SEQUENCE,
      anchor: { kind: AnchorKind.TESTID, value: DISMISS },
      steps: [
        {
          tool: ReticleTool.ACT,
          anchor: { kind: AnchorKind.TESTID, value: DISMISS },
          action: ActionType.CLICK,
          args: {},
          expect: { element: { testid: BANNER, absent: true } },
        },
      ],
    };
    const steps = await replayFlow(
      page,
      flowOf([sequence]),
      waitForPredicate,
      FAST_MS,
      false,
      noSleep,
    );

    expect(steps[0]?.ok, 'the sub-step asserted an absence that does not hold').toBe(false);
  });
});

describe('the recorder, at the point an act_and_wait is captured', () => {
  function capture(until: unknown): RecordedStep | undefined {
    const captured: RecordedStep[] = [];
    captureAct(
      { active: () => [], capture: (step) => captured.push(step) },
      { ref: 'ref-1', action: ActionType.CLICK, args: {}, until },
      { testid: DISMISS },
    );
    return captured[0];
  }

  it('writes the negative expectation onto the step it captures', () => {
    // This is the reported call: `act_and_wait { until: { kind:'element', …, absent:true } }`
    // answered `verified: yes`, and `record{stop}` then saved presence.
    const step = capture({ kind: PredicateKind.ELEMENT, query: { testid: BANNER }, absent: true });
    expect(step?.args['value'], 'the anchor is untouched by any of this').toBe(DISMISS);
    expect(step?.expect).toEqual({ element: { testid: BANNER, absent: true } });
  });

  it('writes no expectation at all when the absence cannot be carried whole', () => {
    const step = capture({
      kind: PredicateKind.ELEMENT,
      query: { role: 'button', name: 'Remove', scope: '#row-2' },
      absent: true,
    });
    expect(step, 'the action is still recorded').toBeDefined();
    expect(step?.expect, 'and it carries no claim the agent did not make').toBeUndefined();
  });
});
