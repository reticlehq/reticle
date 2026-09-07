/**
 * A presence predicate must not be satisfiable with nothing on screen (#797).
 *
 * `{ kind: "element", role: "alert" }` and a bare `text` clause are the natural way to ask "did an
 * error appear", and both were answerable without anything appearing:
 *
 *  - a toast library's permanently-mounted, unnamed `role="alert"` live region never leaves the DOM
 *    and is visible, so the role-only clause was a permanent green;
 *  - dialog content present-but-hidden before a click satisfied a text clause, so the click was
 *    graded `already_true` and never actually graded.
 *
 * These tests pin the two halves of the answer: hidden-only matches stop passing, nameless-only
 * matches keep passing and say what they rested on.
 */
import { describe, it, expect } from 'vitest';
import {
  asRef,
  ElementState,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type ElementQuery,
  type MatchResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

function alert(ref: string, name: string, visible: boolean): ElementDescriptor {
  return { ref: asRef(ref), role: 'alert', name, states: [], visible, text: name };
}

/** The reported page: a real error toast beside the library's always-present empty container. */
const NAMED_TOAST = alert('e116', 'Invalid login credentials', true);
/** The live region itself: always mounted, visible, and unnamed. */
const EMPTY_LIVE_REGION = alert('e113', '', true);
/** Dialog copy that is in the DOM before the click, but not shown. */
const HIDDEN_HEADING: ElementDescriptor = {
  ref: asRef('e200'),
  role: 'heading',
  name: 'Delete account?',
  states: [],
  visible: false,
  text: 'Delete account?',
};

/**
 * Returns whatever it was seeded with, honouring only `state` filtering the way the browser does,
 * so a test can hand the evaluator exactly the DOM the report describes.
 */
class PageSession implements PredicateSession {
  constructor(
    private readonly page: readonly ElementDescriptor[],
    /** Set below `page.length` to model a match the browser truncated. */
    private readonly reportedCount?: number,
  ) {}

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name !== ReticleCommand.MATCH) {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    const query = (args['query'] ?? {}) as ElementQuery;
    const state = args['state'] as string | undefined;
    let matched = this.page.filter(
      (element) =>
        (undefined === query.role || element.role === query.role) &&
        (undefined === query.name || element.name === query.name) &&
        (undefined === query.text || (element.text ?? '').includes(query.text)),
    );
    if (ElementState.VISIBLE === state) matched = matched.filter((element) => element.visible);
    const result: MatchResult = {
      matched: matched.length > 0,
      count: this.reportedCount ?? matched.length,
      elements: matched,
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

describe('a presence match nobody can see is not an appearance', () => {
  it('fails a text clause answered only by hidden content', async () => {
    const session = new PageSession([HIDDEN_HEADING]);
    const result = await evaluatePredicate(session, {
      kind: 'text',
      contains: 'Delete account?',
    });
    expect(result.pass, 'hidden-only content has not appeared').toBe(false);
    expect(result.assertion).toBe('element.visible');
    expect(result.failureReason).toContain('visible');
  });

  it('names the escape hatch, so presence-regardless-of-visibility stays available', async () => {
    const session = new PageSession([HIDDEN_HEADING]);
    const result = await evaluatePredicate(session, { kind: 'text', contains: 'Delete account?' });
    expect(result.failureReason).toContain('state: "present"');
  });

  it('passes the same clause when the caller states the intent', async () => {
    const session = new PageSession([HIDDEN_HEADING]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { text: 'Delete account?' },
      state: ElementState.PRESENT,
    });
    expect(result.pass, 'a stated state is not second-guessed').toBe(true);
  });

  it('still passes when one of several matches is visible', async () => {
    const session = new PageSession([
      HIDDEN_HEADING,
      { ...HIDDEN_HEADING, ref: asRef('e201'), visible: true },
    ]);
    const result = await evaluatePredicate(session, { kind: 'text', contains: 'Delete account?' });
    expect(result.pass).toBe(true);
    expect(result.caveat, 'a named visible match needs no qualification').toBeUndefined();
  });

  it('does not claim every match is hidden when the browser truncated the list', async () => {
    // 12 matched, 1 described. "All of them are hidden" is not a claim this evidence supports, and
    // a wrong failure sends an agent to fix working code.
    const session = new PageSession([HIDDEN_HEADING], 12);
    const result = await evaluatePredicate(session, { kind: 'text', contains: 'Delete account?' });
    expect(result.pass).toBe(true);
  });
});

describe('a role-only clause satisfied by an unnamed container says so', () => {
  it('passes but qualifies the verdict when the only match is the empty live region', async () => {
    const session = new PageSession([EMPTY_LIVE_REGION]);
    const result = await evaluatePredicate(session, { kind: 'element', query: { role: 'alert' } });
    expect(
      result.pass,
      'unnamed roles are legitimate; failing would break correct assertions',
    ).toBe(true);
    expect(result.caveat, 'the hollow match must be reported').toBeDefined();
    expect(result.caveat).toContain('unnamed');
  });

  it('does not qualify a verdict once a real named alert is on screen', async () => {
    const session = new PageSession([NAMED_TOAST, EMPTY_LIVE_REGION]);
    const result = await evaluatePredicate(session, { kind: 'element', query: { role: 'alert' } });
    expect(result.pass).toBe(true);
    expect(result.caveat, 'a named match answered the clause').toBeUndefined();
  });

  it('does not qualify a verdict when the query itself discriminates', async () => {
    const session = new PageSession([{ ...EMPTY_LIVE_REGION, name: 'Saved' }]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'alert', name: 'Saved' },
    });
    expect(result.pass).toBe(true);
    expect(result.caveat).toBeUndefined();
  });

  it('reports the hollow match rather than failing it, so absence checks are untouched', async () => {
    const session = new PageSession([EMPTY_LIVE_REGION]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'alert' },
      absent: true,
    });
    expect(result.pass, 'the container IS there, so an absence check correctly fails').toBe(false);
  });
});
