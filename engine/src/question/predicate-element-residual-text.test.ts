/**
 * A `text` field that the browser's locator drops (`{ role: "alert", text }`) is checked on this side,
 * against the element's text. Without `fullText`, the page describes an element with its 80-character
 * display text, so a check for a longer text, or for words past the cut, answered `no` while the
 * page showed them.
 */
import { describe, expect, it } from 'vitest';
import {
  asRef,
  MatchArg,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type MatchResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate/predicate.js';

const FULL =
  'Your payment could not be processed because the card issuer declined it. Try another card.';
const DISPLAY_CUT = 80;

/** A page that describes with the display text unless it is asked for the full text. */
class AlertPage implements PredicateSession {
  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    const full = ReticleCommand.MATCH === name && true === args[MatchArg.FULL_TEXT];
    const element: ElementDescriptor = {
      ref: asRef('r1'),
      role: 'alert',
      name: '',
      text: full ? FULL : FULL.slice(0, DISPLAY_CUT),
      states: [],
      visible: true,
    };
    const result: MatchResult = {
      matched: true,
      count: 1,
      elements: [element],
      ...(full ? { fullText: true } : {}),
    };
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

describe('a text field checked on this side reads the full text', () => {
  it('passes for words past the 80-character display cut', async () => {
    const result = await evaluatePredicate(new AlertPage(), {
      kind: 'element',
      query: { role: 'alert', text: 'Try another card' },
    });
    expect(result.pass).toBe(true);
  });
});
