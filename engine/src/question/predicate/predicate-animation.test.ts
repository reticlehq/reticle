import { describe, expect, it } from 'vitest';
import {
  asRef,
  EventType,
  ReticleCommand,
  ANIMATION_TARGET_ARG,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';

import { evaluatePredicate, type PredicateSession } from './predicate.js';

function ev(type: EventType, data: Record<string, unknown>, t = 1, ref?: string): ReticleEvent {
  return { t, type, sessionId: 's', data, ...(ref !== undefined ? { ref } : {}) };
}

const spinner = {
  ref: asRef('e1'),
  role: 'status',
  name: 'Loading',
  states: [],
  visible: true,
};

class AnimationSession implements PredicateSession {
  readonly commands: { name: string; args: Record<string, unknown> }[] = [];

  constructor(
    private readonly events: ReticleEvent[],
    private readonly animationResult: unknown,
  ) {}

  elapsed(): number {
    return 0;
  }

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    this.commands.push({ name, args });
    if (ReticleCommand.ANIMATIONS === name) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'animations',
        ok: true,
        result: this.animationResult,
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(cursor = 0): ReticleEvent[] {
    return this.events.filter((event) => event.t >= cursor);
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

describe('animation predicate', () => {
  it('matches a selector target against the event ref it resolves to', async () => {
    const session = new AnimationSession([ev(EventType.ANIM_START, { name: 'spin' }, 10, 'e1')], {
      animations: [],
      target: { target: '.spinner', matched: true, refs: ['e1'] },
    });

    const result = await evaluatePredicate(session, {
      kind: 'animation',
      name: 'spin',
      target: '.spinner',
    });

    expect(result.pass).toBe(true);
    expect(session.commands).toContainEqual({
      name: ReticleCommand.ANIMATIONS,
      args: { [ANIMATION_TARGET_ARG]: '.spinner' },
    });
  });

  it('matches an already-running animation when the start event is not in the window', async () => {
    const session = new AnimationSession([], {
      animations: [{ name: 'spin', playState: 'running', target: spinner, targetMatches: true }],
      target: { target: '.spinner', matched: true, refs: ['e1'] },
    });

    const result = await evaluatePredicate(session, {
      kind: 'animation',
      name: 'spin',
      target: '.spinner',
    });

    expect(result.pass).toBe(true);
    expect(result.evidence).toMatchObject({ playState: 'running' });
  });

  it('matches a completed animation from a finished live animation when no end event arrived', async () => {
    const session = new AnimationSession([], {
      animations: [{ name: 'fade-out', playState: 'finished', target: spinner }],
    });

    const result = await evaluatePredicate(session, {
      kind: 'animation',
      name: 'fade-out',
      completed: true,
    });

    expect(result.pass).toBe(true);
    expect(result.evidence).toMatchObject({ playState: 'finished' });
  });

  it('does not satisfy a since-bounded completed predicate from current live animation state', async () => {
    const session = new AnimationSession([], {
      animations: [{ name: 'fade-out', playState: 'finished', target: spinner }],
    });

    const result = await evaluatePredicate(session, {
      kind: 'animation',
      name: 'fade-out',
      completed: true,
      since: 5,
    });

    expect(result.pass).toBe(false);
    expect(session.commands).toHaveLength(0);
  });

  it('does not satisfy a caller-bounded predicate from current live animation state', async () => {
    const session = new AnimationSession([], {
      animations: [{ name: 'spin', playState: 'running', target: spinner }],
    });

    const result = await evaluatePredicate(session, { kind: 'animation', name: 'spin' }, 10);

    expect(result.pass).toBe(false);
    expect(session.commands).toHaveLength(0);
  });

  it('names the animations seen on a miss instead of reporting an empty window', async () => {
    const session = new AnimationSession([], {
      animations: [{ name: 'pulse', playState: 'running', target: spinner }],
    });

    const result = await evaluatePredicate(session, { kind: 'animation', name: 'fade' });

    expect(result.pass).toBe(false);
    expect(result.observed).toContain('pulse');
    expect(result.observed).toContain('Loading');
  });

  it('refuses a selector target that resolves to no element', async () => {
    const session = new AnimationSession([], {
      animations: [{ name: 'spin', playState: 'running', target: spinner, targetMatches: false }],
      target: { target: '.missing', matched: false, refs: [] },
    });

    const result = await evaluatePredicate(session, {
      kind: 'animation',
      name: 'spin',
      target: '.missing',
    });

    expect(result.pass).toBe(false);
    expect(result.failureReason).toContain('target selector ".missing" matched no element');
    expect(result.assertion).toBe('animation.target');
  });
});
