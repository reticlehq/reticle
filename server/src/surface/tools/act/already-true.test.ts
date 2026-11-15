import { describe, expect, it } from 'vitest';
import {
  EventType,
  PredicateKind,
  ReticleCommand,
  type CommandResult,
  type Predicate,
  type ReticleEvent,
} from '@reticlehq/core';
import type { PredicateSession } from '@reticlehq/engine/question/predicate/predicate-session.js';
import { readAlreadyTrue } from './already-true.js';

/**
 * The pre-check before an action, when a page read throws (#1656).
 *
 * A composite no longer rejects when one clause's read throws: the clause is inconclusive. Read as
 * "not already true", the action then ran, and a later pass was a `yes` the action may not have
 * caused. The pre-check must not say "not already true" when it could not tell.
 */

const MATCH_TIMEOUT = "command 'match' timed out after 3546ms";

/** A page that records network events but cannot answer a page read. */
class SlowPageSession implements PredicateSession {
  constructor(private readonly events: ReticleEvent[] = []) {}

  elapsed(): number {
    return 0;
  }

  command(name: string): Promise<CommandResult> {
    if (name === ReticleCommand.MATCH) {
      return Promise.reject(new Error(MATCH_TIMEOUT));
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }

  eventsSince(cursor = 0): ReticleEvent[] {
    return this.events.filter((e) => e.t >= cursor);
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

const textA: Predicate = { kind: PredicateKind.TEXT, contains: 'Saved' };
const textB: Predicate = { kind: PredicateKind.TEXT, contains: 'Done' };

describe('readAlreadyTrue when a read throws (#1656)', () => {
  it('an anyOf whose reads throw stops the call with the read error, not "not already true"', async () => {
    const until: Predicate = { kind: PredicateKind.ANY_OF, predicates: [textA, textB] };
    await expect(readAlreadyTrue(new SlowPageSession(), until, 0)).rejects.toThrow(MATCH_TIMEOUT);
  });

  it('a lone clause whose read throws stops the call the same way', async () => {
    await expect(readAlreadyTrue(new SlowPageSession(), textA, 0)).rejects.toThrow(MATCH_TIMEOUT);
  });

  it('an allOf with a clause that failed is not already true, so the action runs', async () => {
    // A failed clause is an answer: the conjunction did not hold before the action.
    const net: Predicate = {
      kind: PredicateKind.NET,
      method: 'POST',
      urlContains: '/api/save',
      status: 200,
    };
    const answered500: ReticleEvent = {
      t: 1,
      type: EventType.NET_REQUEST,
      sessionId: 's',
      data: { method: 'POST', url: '/api/save', status: 500 },
    };
    const until: Predicate = { kind: PredicateKind.ALL_OF, predicates: [textA, net] };
    const reading = await readAlreadyTrue(new SlowPageSession([answered500]), until, 0);
    expect(reading.alreadyTrue).toBe(false);
  });
});
