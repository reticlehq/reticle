import { expect, it } from 'vitest';
import type { CommandResult, MatchResult } from '@reticlehq/core';
import { asRef, ElementState } from '@reticlehq/core';

import { evalElement, ARIA_HIDDEN_NOTE } from './predicate-element.js';
import type { PredicateSession } from './predicate-session.js';

const session: PredicateSession = {
  command(name) {
    throw new Error(`invalid element query reached the browser: ${name}`);
  },
  eventsSince: () => [],
  onEvent: () => () => undefined,
  elapsed: () => 0,
};

/** A fake session whose `command` returns a sequence of scripted MatchResults. */
function scriptedSession(results: MatchResult[]): PredicateSession {
  let call = 0;
  return {
    command: () => {
      const result = results[call++];
      return Promise.resolve({ ok: true, result } as unknown as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

const ariaHiddenRef = asRef('e1');

it('maps the query-tool role spelling in direct element evaluation', async () => {
  const result = await evalElement(
    session,
    { by: 'role', role: 'button', name: 'Save' },
    undefined,
    false,
    true,
  );
  expect(result.inconclusive).toContain('{"by":"role","value":"button","name":"Save"}');
  expect(result.inconclusive).toContain('{"role":"button","name":"Save"}');
});

it('names the aria-hidden exclusion on a terminal text miss', async () => {
  const miss: MatchResult = {
    matched: false,
    count: 0,
    elements: [],
    hint: {
      route: '/',
      presentTestids: [],
      presentRegions: [],
      knownEmptyState: false,
      ariaHiddenMatch: {
        ref: ariaHiddenRef,
        role: 'text',
        name: '',
        states: [],
        visible: false,
      },
    },
  };
  const result = await evalElement(scriptedSession([miss]), { text: 'F' }, undefined, false, true);
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain(ARIA_HIDDEN_NOTE);
});

it('names the aria-hidden exclusion on a state near-miss', async () => {
  const miss: MatchResult = {
    matched: false,
    count: 0,
    elements: [],
    hint: {
      route: '/',
      presentTestids: [],
      presentRegions: [],
      knownEmptyState: false,
      ariaHiddenMatch: {
        ref: ariaHiddenRef,
        role: 'text',
        name: '',
        states: [],
        visible: false,
      },
    },
  };
  const relaxed: MatchResult = {
    matched: true,
    count: 1,
    elements: [{ ref: ariaHiddenRef, role: 'text', name: '', states: ['hidden'], visible: false }],
  };
  const result = await evalElement(
    scriptedSession([miss, relaxed]),
    { text: 'F' },
    'visible',
    false,
    true,
  );
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain(ARIA_HIDDEN_NOTE);
  expect(result.failureReason).toContain("not in state 'visible'");
});
/**
 * `pressed` is a state a page built before it cannot answer: its SDK checks the state list, never
 * finds the name, and reports "not in that state". So `{ state: "pressed", absent: true }` against
 * that page passed whatever the button showed. The daemon knows the page's SDK version; a state
 * newer than it is inconclusive, and the page is never asked.
 */
it('is inconclusive for a state the page SDK predates, without asking the page', async () => {
  const old: PredicateSession = { ...session, sdkVersion: '3.3.0' };
  const result = await evalElement(
    old,
    { role: 'button', name: 'Bold' },
    ElementState.PRESSED,
    true,
    true,
  );
  expect(result.pass).toBe(false);
  expect(result.inconclusive).toContain('3.3.0');
  expect(result.inconclusive).toContain('pressed');
});

it('asks the page when its SDK knows the state, or when no version was reported', async () => {
  for (const sdkVersion of ['3.4.0', '3.4.0-rc.1', undefined]) {
    let asked = false;
    const current: PredicateSession = {
      ...session,
      ...(sdkVersion === undefined ? {} : { sdkVersion }),
      command() {
        asked = true;
        return Promise.resolve({ kind: 'command_result', ok: false, id: 'stub', error: 'stub' });
      },
    };
    await evalElement(
      current,
      { role: 'button', name: 'Bold' },
      ElementState.PRESSED,
      false,
      false,
    );
    expect(asked).toBe(true);
  }
});
