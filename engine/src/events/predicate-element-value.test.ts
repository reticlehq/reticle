/**
 * An element predicate must CHECK every field it was handed, or say it could not.
 *
 * Reported from an MCP session: `{ kind: "element", role: "textbox", name: "GST amount",
 * value: "274.58" }` returned `pass: true` against an EMPTY field. `value` was folded into the
 * element's `query`, where the browser's locator grammar reads it only as the operand for `by` — with
 * no `by` the branch never runs, so the value half of the predicate was discarded and what remained
 * ("a textbox named GST amount exists") is trivially true. A false green produced by the tool whose
 * whole purpose is to prevent them.
 */
import { describe, it, expect } from 'vitest';
import {
  asRef,
  QueryBy,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type ElementQuery,
  type MatchResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

function el(over: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    ref: asRef('r1'),
    role: 'textbox',
    name: 'GST amount',
    states: [],
    visible: true,
    ...over,
  };
}

/** Answers MATCH with a fixed element list, whatever the query — the locator half is not under test. */
class MatchingSession implements PredicateSession {
  seen: ElementQuery[] = [];
  constructor(private readonly elements: ElementDescriptor[]) {}
  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.MATCH) this.seen.push(args['query'] ?? {});
    const result: MatchResult = {
      matched: this.elements.length > 0,
      count: this.elements.length,
      elements: this.elements,
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

describe('element predicate: value', () => {
  it('fails when the field is empty and the predicate names a value', async () => {
    // The reported call, verbatim. The field held nothing.
    const session = new MatchingSession([el()]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'textbox', name: 'GST amount', value: '274.58' },
    });
    expect(result.pass, 'an empty field must not satisfy a value assertion').toBe(false);
    expect(result.assertion).toBe('element.value');
    expect(result.observed).toContain('GST amount');
  });

  it('passes when the field holds the named value', async () => {
    const session = new MatchingSession([el({ value: '274.58' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'textbox', name: 'GST amount', value: '274.58' },
    });
    expect(result.pass).toBe(true);
  });

  it('compares the value trimmed, so surrounding whitespace is not a failure', async () => {
    const session = new MatchingSession([el({ value: ' 274.58 ' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'textbox', name: 'GST amount', value: '274.58' },
    });
    expect(result.pass).toBe(true);
  });

  it('an empty string asserts the field IS empty', async () => {
    // describe() omits `value` entirely when it is blank, so "" and absent are the same fact.
    const cleared = new MatchingSession([el()]);
    const filled = new MatchingSession([el({ value: '300' })]);
    expect(
      (await evaluatePredicate(cleared, { kind: 'element', query: { role: 'textbox', value: '' } }))
        .pass,
    ).toBe(true);
    expect(
      (await evaluatePredicate(filled, { kind: 'element', query: { role: 'textbox', value: '' } }))
        .pass,
    ).toBe(false);
  });

  it('leaves `value` alone when it is the operand of `by` — that is the locator grammar', async () => {
    const session = new MatchingSession([el({ role: 'textbox', name: 'GST amount' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { by: QueryBy.ROLE, value: 'textbox' },
    });
    expect(result.pass, 'by+value is a locator, not a value assertion').toBe(true);
  });

  it('absent: a value that is not there satisfies an absence check', async () => {
    const session = new MatchingSession([el({ value: '300' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'textbox', name: 'GST amount', value: '274.58' },
      absent: true,
    });
    expect(result.pass).toBe(true);
  });
});

describe('element predicate: fields the locator never reads', () => {
  it('checks `text` that the role branch would have swallowed', async () => {
    // Our own cheatsheet advertises `{ role: "button", text: "Save" }`. The browser resolves by role
    // and drops `text`, so it matched EVERY button on the page.
    const session = new MatchingSession([el({ role: 'button', name: 'Cancel' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'button', text: 'Save' },
    });
    expect(result.pass, 'a Cancel button must not satisfy text "Save"').toBe(false);
  });

  it('checks `name` that a testid locator would have swallowed', async () => {
    const session = new MatchingSession([el({ role: 'button', name: 'Cancel' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { testid: 'row-3', name: 'Save' },
    });
    expect(result.pass).toBe(false);
  });

  it('refuses, rather than ignores, a field it cannot check itself', async () => {
    // `testid` is not on the descriptor, so when the locator resolves by role there is nothing on the
    // server side to compare it against. A refusal costs one turn; a silent pass costs a wrong green.
    const session = new MatchingSession([el({ role: 'button', name: 'Save' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'button', name: 'Save', testid: 'save-btn' },
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('testid');
  });

  it('refuses `by` with no `value` — the strategy has no operand and does nothing', async () => {
    const session = new MatchingSession([el({ role: 'button', name: 'Save' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { by: QueryBy.TESTID, role: 'button' },
    });
    expect(result.inconclusive).toContain('by');
  });

  it('says nothing about a query whose every field the locator uses', async () => {
    const session = new MatchingSession([el({ role: 'button', name: 'Save' })]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'button', name: 'Save' },
    });
    expect(result.pass).toBe(true);
    expect(result.inconclusive).toBeUndefined();
  });
});
