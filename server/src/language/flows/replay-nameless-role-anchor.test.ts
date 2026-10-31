/**
 * A control with no accessible name must still be replayable.
 *
 * Icon-only buttons (edit, delete, QR code) have a role and no name. A saved flow anchored them as
 * `{ role: "button", nth, of }`, but replay sent every nameless role anchor down the testid path,
 * which queried the ROLE as a testid and failed with `testid "button" not found` — on a working
 * app. The fix resolves a nameless role anchor among the controls that share its role AND have no
 * name, by its recorded position, and says the real reason when it cannot.
 */

import { describe, expect, it } from 'vitest';
import {
  asRef,
  ActionType,
  AnchorKind,
  DriftReason,
  ReticleCommand,
  ReticleTool,
  QueryBy,
  asString,
  type CommandResult,
  FLOW_FILE_VERSION,
  type ElementDescriptor,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession } from './flow-replay.js';
import { anchorForStep } from './flows.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';

function el(ref: string, role: string, name: string): ElementDescriptor {
  return { ref: asRef(ref), role, name, states: [], visible: true };
}

/** A row of controls: two named buttons and the given number of icon-only (nameless) buttons. */
class FakeRowSession implements FlowReplaySession {
  readonly acts: string[] = [];
  readonly queries: Array<Record<string, unknown>> = [];
  constructor(private readonly nameless: number) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.QUERY) {
      this.queries.push(args);
      const role = asString(args['value']) ?? '';
      const wanted = asString(args['name']);
      const page = [
        el('copy', 'button', 'Copy'),
        ...Array.from({ length: this.nameless }, (_, i) => el(`icon-${String(i)}`, 'button', '')),
        el('close', 'button', 'Close'),
      ].filter((e) => e.role === role && (wanted === undefined || e.name === wanted));
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: {
          elements: page,
          hint: { route: '/', presentTestids: [], knownEmptyState: false },
        },
      });
    }
    if (name === ReticleCommand.ACT) {
      this.acts.push(asString(args['ref']) ?? '');
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
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

function step(anchor: Record<string, unknown>): FlowStep {
  return {
    tool: ReticleTool.ACT,
    anchor,
    action: ActionType.CLICK,
    args: {},
  } as unknown as FlowStep;
}

function flow(steps: FlowStep[]): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'f', createdAt: 0, steps };
}

async function replayOne(session: FakeRowSession, anchor: Record<string, unknown>) {
  const results = await replayFlow(session, flow([step(anchor)]), waitForPredicate, 50, false, () =>
    Promise.resolve(),
  );
  return results[0];
}

describe('a nameless role anchor', () => {
  it('acts on the control at its recorded position among the nameless controls of that role', async () => {
    const session = new FakeRowSession(3);
    const result = await replayOne(session, {
      kind: AnchorKind.ROLE,
      role: 'button',
      nth: 1,
      of: 3,
    });
    expect(result?.ok).toBe(true);
    expect(session.acts).toEqual(['icon-1']);
  });

  it('counts only nameless controls, so named buttons of the same role do not shift the position', async () => {
    const session = new FakeRowSession(2);
    await replayOne(session, { kind: AnchorKind.ROLE, role: 'button', nth: 0, of: 2 });
    expect(session.acts).toEqual(['icon-0']);
  });

  it('acts on the only nameless control when the anchor carries no position', async () => {
    const session = new FakeRowSession(1);
    const result = await replayOne(session, { kind: AnchorKind.ROLE, role: 'button' });
    expect(result?.ok).toBe(true);
    expect(session.acts).toEqual(['icon-0']);
  });

  it('drifts as ambiguous, without acting, when the count differs from the recorded one', async () => {
    const session = new FakeRowSession(4);
    const result = await replayOne(session, {
      kind: AnchorKind.ROLE,
      role: 'button',
      nth: 1,
      of: 3,
    });
    expect(result?.ok).toBe(false);
    expect(result?.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
    expect(session.acts).toEqual([]);
  });

  it('never reports the role as a missing testid', async () => {
    const session = new FakeRowSession(0);
    const result = await replayOne(session, {
      kind: AnchorKind.ROLE,
      role: 'button',
      nth: 0,
      of: 2,
    });
    expect(result?.ok).toBe(false);
    expect(result?.drift?.reason).not.toContain('testid');
    expect(result?.drift?.reason).toContain('no accessible name');
  });

  it('queries by role, not by testid', async () => {
    const session = new FakeRowSession(2);
    await replayOne(session, { kind: AnchorKind.ROLE, role: 'button', nth: 0, of: 2 });
    expect(session.queries.every((q) => q['by'] === QueryBy.ROLE)).toBe(true);
  });
});

describe('compiling a step on a nameless control', () => {
  it('saves a positional role anchor instead of the degraded placeholder', () => {
    const { anchor, degraded } = anchorForStep({
      by: QueryBy.ROLE,
      value: 'button',
      nth: 1,
      of: 3,
    });
    expect(degraded).toBe(false);
    expect(anchor).toEqual({ kind: AnchorKind.ROLE, role: 'button', nth: 1, of: 3 });
  });

  it('saves a bare role anchor when the control was the only nameless one of its role', () => {
    const { anchor, degraded } = anchorForStep({ by: QueryBy.ROLE, value: 'button' });
    expect(degraded).toBe(false);
    expect(anchor).toEqual({ kind: AnchorKind.ROLE, role: 'button' });
  });
});

/*
 * The click re-rendered the row before it landed, so the first act met a stale ref and replay
 * re-resolved the anchor. The re-resolve counted ALL buttons of the role (named ones too), found 4
 * where the anchor recorded 2, and reported the step ambiguous on a working page.
 */
describe('a nameless role anchor whose ref went stale', () => {
  it('re-resolves among the nameless controls only, and acts on the same position', async () => {
    const session = new FakeRowSession(2);
    let first = true;
    const act = session.command.bind(session);
    session.command = (name: string, args: Record<string, unknown> = {}) => {
      if (name === ReticleCommand.ACT && first) {
        first = false;
        session.acts.push(asString(args['ref']) ?? '');
        return Promise.resolve({
          kind: 'command_result',
          id: 'a',
          ok: false,
          error: `ref '${asString(args['ref']) ?? ''}' no longer resolves to an element`,
        });
      }
      return act(name, args);
    };
    const result = await replayOne(session, {
      kind: AnchorKind.ROLE,
      role: 'button',
      nth: 1,
      of: 2,
    });
    expect(result?.ok).toBe(true);
    expect(session.acts).toEqual(['icon-1', 'icon-1']);
  });
});
