/**
 * A recorded text field replays when the input type changes (#2058).
 *
 * "An input labelled `Max clicks:`" can be built as `type="number"` (role `spinbutton`) or as
 * `type="text"` (role `textbox`). The recorder saved the role it saw, so a flow recorded on one build
 * failed on the other: `role anchor spinbutton "Max clicks:" not found`. The flow encoded an input
 * type the user never asked for. A role anchor takes `alsoRoles` (#2081), so the recorder now saves
 * the other text-entry roles with a named field.
 */
import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  FlowAnchorSchema,
  ReticleCommand,
  ReticleTool,
  asRef,
  asString,
  type CommandResult,
  type FlowAnchor,
  type FlowFile,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { anchorForStep } from './flows.js';

const LABEL = 'Max clicks:';

/** A page with one field labelled "Max clicks:", exposed with `role`. */
function page(role: string): FlowReplaySession {
  return {
    command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
      const matches = ReticleCommand.QUERY === name && asString(args['value']) === role;
      const result =
        ReticleCommand.QUERY === name
          ? {
              elements: matches
                ? [{ ref: asRef('e-1'), role, name: LABEL, states: [], visible: true }]
                : [],
              hint: { route: '/', presentTestids: [], knownEmptyState: false },
            }
          : { dispatched: true, settled: true, valueChanged: true };
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

/** The anchor the recorder saves for a fill on a field exposed with `role`. */
const recorded = (role: string, extra: Record<string, unknown> = {}): FlowAnchor =>
  anchorForStep({ by: 'role', value: role, name: LABEL, ...extra }).anchor;

const fillFlow = (anchor: FlowAnchor): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'max-clicks',
  createdAt: 0,
  steps: [{ tool: ReticleTool.ACT, anchor, action: ActionType.FILL, args: { value: '5' } }],
});

describe('a named text field, as the recorder saves it', () => {
  it('a number input also accepts the text-entry roles', () => {
    expect(recorded('spinbutton')).toEqual({
      kind: AnchorKind.ROLE,
      role: 'spinbutton',
      name: LABEL,
      alsoRoles: ['textbox', 'searchbox'],
    });
  });

  it('a text input also accepts a number input and a search box', () => {
    expect(recorded('textbox')).toMatchObject({
      role: 'textbox',
      alsoRoles: ['spinbutton', 'searchbox'],
    });
    expect(recorded('searchbox')).toMatchObject({
      role: 'searchbox',
      alsoRoles: ['textbox', 'spinbutton'],
    });
  });

  it('is a valid flow anchor', () => {
    expect(FlowAnchorSchema.safeParse(recorded('spinbutton')).success).toBe(true);
  });

  it('replays on a text input when it was recorded on a number input', async () => {
    const [step] = await replayFlow(
      page('textbox'),
      fillFlow(recorded('spinbutton')),
      waitForPredicate,
      60,
    );
    expect(step?.ok).toBe(true);
  });

  it('replays on a number input when it was recorded on a text input', async () => {
    const [step] = await replayFlow(
      page('spinbutton'),
      fillFlow(recorded('textbox')),
      waitForPredicate,
      60,
    );
    expect(step?.ok).toBe(true);
  });
});

describe('what keeps one role', () => {
  // `alsoRoles` cannot be used with `nth`: a position counts the controls of one role.
  it('a field recorded among namesakes keeps its position and its one role', () => {
    const anchor = recorded('textbox', { nth: 1, of: 2 });
    expect(anchor).toEqual({ kind: AnchorKind.ROLE, role: 'textbox', name: LABEL, nth: 1, of: 2 });
    expect(FlowAnchorSchema.safeParse(anchor).success).toBe(true);
  });

  it('a nameless field keeps its one role', () => {
    expect(anchorForStep({ by: 'role', value: 'textbox' }).anchor).toEqual({
      kind: AnchorKind.ROLE,
      role: 'textbox',
    });
  });

  it('a control that is not a text field keeps its one role', () => {
    expect(recorded('checkbox')).toEqual({ kind: AnchorKind.ROLE, role: 'checkbox', name: LABEL });
    expect(recorded('combobox')).toEqual({ kind: AnchorKind.ROLE, role: 'combobox', name: LABEL });
  });

  it('still drifts on a checkbox with the same label', async () => {
    const [step] = await replayFlow(
      page('checkbox'),
      fillFlow(recorded('spinbutton')),
      waitForPredicate,
      60,
    );
    expect(step?.ok).toBe(false);
  });
});
