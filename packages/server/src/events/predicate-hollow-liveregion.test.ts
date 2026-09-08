/**
 * A mounted live region is not an announcement.
 *
 * `{ kind: "element", role: "alert" }` is the shape an agent reaches for to prove an error surfaced.
 * Every toast library on the market mounts its live region at boot and leaves it there — empty,
 * unnamed, permanently in the DOM — so on those apps the clause is satisfied with ZERO errors on
 * screen, and it never fails. A predicate that cannot fail is not a check.
 *
 * The report that found it: a failed-login assertion whose `allOf` carried a 400 response, the login
 * route, and `role: "alert"`. The evidence listed two matches — the real toast, and `e113` with
 * `name: ""`, which appeared UNCHANGED in both runs because it had never gone anywhere.
 *
 * The rule is narrow on purpose. It applies only to the roles that exist to ANNOUNCE content, and
 * only when the caller named no content of their own — a `name`, `text` or `testid` in the query is
 * a deliberate, specific claim and is left exactly as it was.
 */

import { describe, expect, it } from 'vitest';
import type { ElementDescriptor, ElementQuery, Ref } from '@reticlehq/core';
import { evaluatePredicate } from './predicate.js';
import type { PredicateSession } from './predicate.js';
import { ReticleCommand } from '@reticlehq/core';
import type { CommandResult, MatchResult, ReticleEvent } from '@reticlehq/core';

const el = (ref: string, role: string, name: string, text?: string): ElementDescriptor => ({
  ref: ref as Ref,
  role,
  name,
  states: [],
  visible: true,
  ...(text === undefined ? {} : { text }),
});

class MatchSession implements PredicateSession {
  constructor(private readonly elements: ElementDescriptor[]) {}
  elapsed(): number {
    return 0;
  }
  ambientCounts(): Record<string, number> {
    return {};
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name !== ReticleCommand.MATCH) {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    const query = (args['query'] ?? {}) as ElementQuery;
    const hits = this.elements.filter(
      (e) =>
        (query.role === undefined || e.role === query.role) &&
        (query.name === undefined || e.name === query.name),
    );
    const result: MatchResult = {
      matched: hits.length > 0,
      count: hits.length,
      elements: hits,
    };
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
  }
}

describe('a bare live-region role must find something announced', () => {
  it('does not pass on the empty container a toast library leaves mounted', async () => {
    const session = new MatchSession([el('e113', 'alert', '')]);
    const result = await evaluatePredicate(session, { kind: 'element', query: { role: 'alert' } });
    expect(result.pass, 'an unnamed, empty alert announced nothing').toBe(false);
    // The distinction has to reach the caller, or they read it as "the toast never rendered" and go
    // looking in the wrong place. It is the container that is empty, not the page that is missing it.
    expect(result.failureReason).toMatch(/empty|no content|announce/i);
  });

  it('passes when a real alert is on screen beside the empty container', async () => {
    // The reported app's actual DOM: the library's permanent container AND the live toast.
    const session = new MatchSession([
      el('e116', 'alert', 'Invalid login credentials'),
      el('e113', 'alert', ''),
    ]);
    const result = await evaluatePredicate(session, { kind: 'element', query: { role: 'alert' } });
    expect(result.pass).toBe(true);
  });

  it('accepts an alert carrying text but no accessible name', async () => {
    const session = new MatchSession([el('e1', 'alert', '', 'Something went wrong')]);
    const result = await evaluatePredicate(session, { kind: 'element', query: { role: 'alert' } });
    expect(result.pass, 'rendered text is content, name or not').toBe(true);
  });

  it('leaves a named query alone — that claim was already specific', async () => {
    const session = new MatchSession([el('e113', 'alert', '')]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'alert', name: 'Invalid login credentials' },
    });
    // Fails because no alert carries that name, not because of the hollow rule.
    expect(result.pass).toBe(false);
  });

  it('leaves ordinary roles alone — an unnamed image or separator is a normal thing to assert', async () => {
    const session = new MatchSession([el('e1', 'img', '')]);
    const result = await evaluatePredicate(session, { kind: 'element', query: { role: 'img' } });
    expect(result.pass, 'only announcement roles carry this rule').toBe(true);
  });

  it('an absence check on a bare live-region role is unaffected', async () => {
    // The mounted empty container must still count as present for `absent: true`, or "no alert is
    // showing" would go green on an app whose alert IS showing. Absence is the caller's claim that
    // NOTHING matched, and the container matched.
    const session = new MatchSession([el('e113', 'alert', '')]);
    const result = await evaluatePredicate(session, {
      kind: 'element',
      query: { role: 'alert' },
      absent: true,
    });
    expect(result.pass).toBe(false);
  });
});
