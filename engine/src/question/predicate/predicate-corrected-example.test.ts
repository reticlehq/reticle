/**
 * A refused predicate shows one corrected predicate built from the agent's own values.
 *
 * The refusal showed one fixed sample for each kind: `{ kind: "text", contains: "Saved" }` for every
 * text predicate. An agent that wrote `{ kind: "text", label: "Order placed" }` then had to map the
 * sample onto its own call. About two in three `bad_args` refusals on `act_and_wait` and `assert`
 * were retried, so each refusal cost one more call. The example now carries the agent's own text.
 */
import { describe, expect, it } from 'vitest';
import {
  ElementState,
  EventType,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { parsePredicate } from './predicate-parse.js';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

const messageOf = (input: unknown): string => {
  try {
    parsePredicate(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected parsePredicate to reject');
};

/** The one corrected predicate in a refusal, parsed back, or undefined when there is none. */
const correctedIn = (message: string): unknown => {
  const found = /from your call: (\{.*\})$/.exec(message);
  return found?.[1] === undefined ? undefined : JSON.parse(found[1]);
};

describe('a refused predicate carries one corrected predicate from the call', () => {
  it('moves the text of an unknown field into the field the kind takes', () => {
    expect(correctedIn(messageOf({ kind: 'text', label: 'Order placed' }))).toEqual({
      kind: 'text',
      contains: 'Order placed',
    });
    expect(correctedIn(messageOf({ kind: 'route', href: '/checkout' }))).toEqual({
      kind: 'route',
      pathname: '/checkout',
    });
    expect(correctedIn(messageOf({ kind: 'signal', event: 'cart:updated' }))).toEqual({
      kind: 'signal',
      name: 'cart:updated',
    });
  });

  it('keeps every valid field the agent wrote, and reads a number or a boolean written as a string', () => {
    expect(
      correctedIn(
        messageOf({
          kind: 'net',
          method: 'POST',
          endpoint: '/api/save',
          status: '200',
          ok: 'true',
        }),
      ),
    ).toEqual({ kind: 'net', method: 'POST', urlContains: '/api/save', status: 200, ok: true });
  });

  it('never takes a call argument (`ref`, `action`) as the text to check', () => {
    expect(correctedIn(messageOf({ kind: 'text', ref: 'e5', caption: 'Save changes' }))).toEqual({
      kind: 'text',
      contains: 'Save changes',
    });
    expect(correctedIn(messageOf({ kind: 'element', caption: 'Save changes' }))).toEqual({
      kind: 'element',
      query: { text: 'Save changes' },
    });
  });

  it('shows no corrected predicate for an `element` with a `ref`: without it the target is lost', () => {
    expect(
      correctedIn(messageOf({ kind: 'element', ref: 'e3', value: '1187.01' })),
    ).toBeUndefined();
  });

  it('refuses a bare string with two readings with those readings only, and no sample of another kind', () => {
    const message = messageOf('/dashboard');
    expect(message).toContain('{ kind: "route", pathname: "/dashboard" }');
    expect(message).toContain('{ kind: "text", contains: "/dashboard" }');
    expect(message).not.toContain('is not a predicate kind');
    expect(message).not.toContain('"Saved"');
  });

  it('says that `absent` is a field, and of which kinds, when it is written as the kind', () => {
    // From #1001: `until: { kind: "absent", ... }` was refused with only the list of kinds.
    expect(messageOf({ kind: 'absent' })).toContain(
      '"absent" is a field of element, text, console',
    );
  });

  it('shows no corrected predicate when two unknown fields both hold text', () => {
    expect(correctedIn(messageOf({ kind: 'text', label: 'a', caption: 'b' }))).toBeUndefined();
  });

  it('shows no corrected predicate when it would drop a value the agent wrote', () => {
    // `status: "two hundred"` cannot be read as a number. A predicate without it checks less than
    // the agent asked for, so it is not offered as a correction.
    const message = messageOf({ kind: 'net', urlContains: '/api', status: 'two hundred' });
    expect(correctedIn(message)).toBeUndefined();
    expect(message).toContain('A valid net predicate looks like');
  });

  it('shows the kind list, not a guess, when the kind is not a kind', () => {
    const message = messageOf({ kind: 'toast', text: 'Saved' });
    expect(correctedIn(message)).toBeUndefined();
    expect(message).toContain('is not a predicate kind');
  });
});

/**
 * A page of elements, filtered the way the page SDK filters: by the query text, and by `visible`
 * when the predicate asks for that state.
 */
function page(elements: readonly { text: string; visible: boolean }[]): PredicateSession {
  return {
    command: (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
      if (ReticleCommand.MATCH !== name) {
        return Promise.reject(new Error(`unexpected command ${name}`));
      }
      const wanted = (args?.['query'] as { text?: string } | undefined)?.text ?? '';
      const onlyVisible = ElementState.VISIBLE === args?.['state'];
      const matched = elements
        .filter((element) => element.text.includes(wanted))
        .filter((element) => !onlyVisible || element.visible)
        .map((element, i) => ({ ref: `e${String(i)}`, role: 'status', name: '', ...element }));
      return Promise.resolve({
        ok: true,
        result: { matched: matched.length > 0, count: matched.length, elements: matched },
      } as CommandResult);
    },
    eventsSince: (): ReticleEvent[] => [
      { t: 1, seq: 1, type: EventType.DOM_ADDED, sessionId: 's', data: { path: 'p' } },
    ],
    onEvent: (): (() => void) => (): void => {},
    elapsed: (): number => 1000,
  };
}

describe('a bare string predicate can fail', () => {
  it('passes on a page that shows the text', async () => {
    const result = await evaluatePredicate(
      page([{ text: 'Saved', visible: true }]),
      parsePredicate('Saved'),
      0,
      false,
    );
    expect(result.pass).toBe(true);
  });

  it('fails on a page without the text', async () => {
    const result = await evaluatePredicate(
      page([{ text: 'Loading', visible: true }]),
      parsePredicate('Saved'),
      0,
      false,
    );
    expect(result.pass).toBe(false);
  });

  it('fails on a page where the text is there but hidden', async () => {
    const result = await evaluatePredicate(
      page([{ text: 'Saved', visible: false }]),
      parsePredicate('Saved'),
      0,
      false,
    );
    expect(result.pass).toBe(false);
  });
});
