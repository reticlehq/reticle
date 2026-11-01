/**
 * A recorded click on one item of a list keeps which item it was.
 *
 * A component anchor names a JSX site, and a list renders every item from one site. Measured on a
 * phone-number input: about 240 country items share one source line, so a recorded click on
 * "Germany" was saved as component + source alone, and a replay could not tell it from any other
 * country. The SDK now reports the item's position among the elements that anchor matches
 * (`componentNth` / `componentOf`); the recorder keeps it on the anchor, and replay acts on that
 * position while the page has as many matches as when it was recorded.
 */
import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FlowFileSchema,
  FlowStepTool,
  FLOW_FILE_VERSION,
  ReticleCommand,
  type CommandResult,
} from '@reticlehq/core';
import { compileActStep, compileSequenceStep } from './replay.js';
import { recordedStepToFlowStep } from './flows.js';
import { runComponentStep } from './flow-step-runners.js';

const SOURCE = { file: 'src/CountryList.tsx', line: 182, column: 14 };
const GERMANY = {
  component: 'CountryList',
  source: SOURCE,
  role: 'listitem',
  componentNth: 1,
  componentOf: 3,
};

describe('a recorded click on one of several same-site elements', () => {
  it('saves the position on the component anchor of a single step', () => {
    const step = recordedStepToFlowStep(
      compileActStep({ ref: 'e7', action: ActionType.CLICK, args: {} }, GERMANY),
    );
    expect(step.anchor).toMatchObject({
      kind: AnchorKind.COMPONENT,
      component: 'CountryList',
      nth: 1,
      of: 3,
    });
  });

  it('saves the position on a sub-step of a sequence', () => {
    const step = recordedStepToFlowStep(
      compileSequenceStep(
        { steps: [{ ref: 'e7', action: ActionType.CLICK, args: {} }] },
        { steps: [GERMANY] },
      ),
    );
    const sub = (step.steps ?? [])[0];
    expect(sub?.anchor).toMatchObject({ kind: AnchorKind.COMPONENT, nth: 1, of: 3 });
  });

  it('keeps no position for the only element of its anchor', () => {
    const step = recordedStepToFlowStep(
      compileActStep(
        { ref: 'e7', action: ActionType.CLICK, args: {} },
        { component: 'Toolbar', source: SOURCE },
      ),
    );
    expect(step.anchor).not.toHaveProperty('nth');
    expect(step.anchor).not.toHaveProperty('of');
  });

  it('is a valid flow file once saved', () => {
    const step = recordedStepToFlowStep(
      compileActStep({ ref: 'e7', action: ActionType.CLICK, args: {} }, GERMANY),
    );
    const parsed = FlowFileSchema.safeParse({
      version: FLOW_FILE_VERSION,
      name: 'pick-germany',
      createdAt: 0,
      steps: [step],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.steps[0]?.anchor).toMatchObject({ nth: 1, of: 3 });
  });
});

/**
 * Replay of a single step acts on the recorded position. The component runner's ambiguity check
 * honoured `nth` through `refFor`, then dispatched at `refs[0]`, so a position that cleared the
 * check still clicked the first item.
 */
describe('a single replayed step with a recorded position', () => {
  it('acts on that position, not on the first match', async () => {
    const acts: string[] = [];
    const session = {
      command: (name: string, args: Record<string, unknown> = {}) => {
        if (ReticleCommand.QUERY === name) {
          const elements = [0, 1, 2].map((i) => ({ ref: `e-${String(i)}` }));
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            result: { elements },
          } as unknown as CommandResult);
        }
        if (ReticleCommand.ACT === name) {
          acts.push(String(args['ref']));
        }
        return Promise.resolve({
          kind: 'command_result',
          id: 'a',
          ok: true,
          result: {},
        } as unknown as CommandResult);
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    const anchor = {
      kind: AnchorKind.COMPONENT,
      component: 'CountryList',
      source: SOURCE,
      nth: 1,
      of: 3,
    } as const;
    const result = await runComponentStep(
      session,
      { tool: FlowStepTool.ACT, anchor, action: ActionType.CLICK, args: {} },
      0,
      anchor,
      false,
      () => Promise.resolve(),
    );
    expect(result.drift).toBeUndefined();
    expect(acts).toEqual(['e-1']);
  });
});
