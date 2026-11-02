/**
 * A replayed click failed on a correct build that named the control differently (#2109). The flow
 * recorded `button "Dismiss error message"` inside an alert inside a dialog. A correct build named
 * the same button "Close message", the name query found nothing, and the step failed.
 *
 * A role anchor now also records the roles of the control's nearest containers (`within`). When the
 * name finds nothing, the replay looks for the only control of the role inside that container chain.
 * One match: act on it. Several: the step is ambiguous (not proved), never a guess. None: it fails.
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
  type FlowFile,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';

interface Node {
  ref: string;
  role: string;
  name: string;
  parent?: string;
}

function inside(nodes: readonly Node[], node: Node, scope: string): boolean {
  let at = node.parent;
  while (at !== undefined) {
    if (at === scope) {
      return true;
    }
    at = nodes.find((n) => n.ref === at)?.parent;
  }
  return false;
}

/** A page of `nodes`; QUERY matches role, optional name and optional scope (a container ref). */
function page(nodes: readonly Node[], clicked: string[]): FlowReplaySession {
  return {
    command(command: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
      let result: unknown = { dispatched: true, settled: true };
      if (ReticleCommand.QUERY === command) {
        const name = asString(args['name']);
        const scope = asString(args['scope']);
        const hits = nodes.filter(
          (n) =>
            n.role === asString(args['value']) &&
            (name === undefined || n.name === name) &&
            (scope === undefined || inside(nodes, n, scope)),
        );
        result = {
          elements: hits.map((n) => ({
            ref: asRef(n.ref),
            role: n.role,
            name: n.name,
            states: [],
            visible: true,
          })),
          hint: { route: '/', presentTestids: [], knownEmptyState: false },
        };
      } else {
        clicked.push(asString(args['ref']) ?? '');
      }
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

const flow = (within?: string[]): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'dismiss',
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: {
        kind: AnchorKind.ROLE,
        role: 'button',
        name: 'Dismiss error message',
        ...(within === undefined ? {} : { within }),
      },
      action: ActionType.CLICK,
      args: {},
    },
  ],
});

const DIALOG: Node[] = [
  { ref: 'e-dialog', role: 'dialog', name: 'Add decision' },
  { ref: 'e-alert', role: 'alert', name: '', parent: 'e-dialog' },
  { ref: 'e-save', role: 'button', name: 'Save', parent: 'e-dialog' },
];

describe('a role anchor with within', () => {
  it('acts on the only button in the recorded alert when the name changed', async () => {
    const clicked: string[] = [];
    const nodes = [
      ...DIALOG,
      { ref: 'e-close', role: 'button', name: 'Close message', parent: 'e-alert' },
    ];
    const [step] = await replayFlow(
      page(nodes, clicked),
      flow(['alert', 'dialog']),
      waitForPredicate,
      60,
    );
    expect(step?.ok).toBe(true);
    expect(clicked).toContain('e-close');
  });

  it('is ambiguous, not a guess, when the alert holds two buttons', async () => {
    const clicked: string[] = [];
    const nodes = [
      ...DIALOG,
      { ref: 'e-close', role: 'button', name: 'Close message', parent: 'e-alert' },
      { ref: 'e-retry', role: 'button', name: 'Retry', parent: 'e-alert' },
    ];
    const [step] = await replayFlow(
      page(nodes, clicked),
      flow(['alert', 'dialog']),
      waitForPredicate,
      60,
    );
    expect(step?.ok).toBe(false);
    expect(step?.drift).toBeDefined();
    expect(clicked).toEqual([]);
  });

  it('still fails when the build has no alert', async () => {
    const clicked: string[] = [];
    const [step] = await replayFlow(
      page(DIALOG, clicked),
      flow(['alert', 'dialog']),
      waitForPredicate,
      60,
    );
    expect(step?.ok).toBe(false);
    expect(clicked).toEqual([]);
  });

  it('still fails a renamed control when the flow recorded no containers', async () => {
    const clicked: string[] = [];
    const nodes = [
      ...DIALOG,
      { ref: 'e-close', role: 'button', name: 'Close message', parent: 'e-alert' },
    ];
    const [step] = await replayFlow(page(nodes, clicked), flow(), waitForPredicate, 60);
    expect(step?.ok).toBe(false);
  });

  it('parses within on a role anchor', () => {
    const parsed = FlowAnchorSchema.safeParse({
      kind: AnchorKind.ROLE,
      role: 'button',
      name: 'x',
      within: ['alert'],
    });
    expect(parsed.success && 'within' in parsed.data ? parsed.data.within : undefined).toEqual([
      'alert',
    ]);
  });
});
