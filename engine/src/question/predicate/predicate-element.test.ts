import { expect, it } from 'vitest';
import { ElementState } from '@reticlehq/core';

import { evalElement } from './predicate-element.js';
import type { PredicateSession } from './predicate-session.js';

const session: PredicateSession = {
  command(name) {
    throw new Error(`invalid element query reached the browser: ${name}`);
  },
  eventsSince: () => [],
  onEvent: () => () => undefined,
  elapsed: () => 0,
};

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

/**
 * `absent` means removed from the DOM, so an element the app hid but kept mounted fails it, and
 * should. The reason used to say only "found 1", next to `visible: false` evidence, which reads as a
 * stuck UI; when every match is hidden it now names `state: "hidden"` (#1360).
 */
function matching(matches: { visible: boolean }[], count = matches.length): PredicateSession {
  const elements = matches.map((m, i) => ({
    ref: `e${String(i)}`,
    role: 'dialog',
    name: 'Settings',
    states: [],
    visible: m.visible,
  }));
  return {
    ...session,
    command: () =>
      Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'stub',
        result: { matched: true, count, elements },
      }),
  };
}

it('points an absent check on a hidden-only match at state: "hidden", and still fails', async () => {
  const one = await evalElement(
    matching([{ visible: false }]),
    { testid: 'x' },
    undefined,
    true,
    true,
  );
  expect(one.pass).toBe(false);
  expect(one.failureReason).toBe(
    'expected element to be absent but found 1, but it is hidden — `absent` means removed from ' +
      'the DOM; to assert it isn\'t shown, use `state: "hidden"`',
  );

  const two = await evalElement(
    matching([{ visible: false }, { visible: false }]),
    { testid: 'x' },
    undefined,
    true,
    true,
  );
  expect(two.pass).toBe(false);
  expect(two.failureReason).toContain('found 2, but every one is hidden');
});

it('keeps the plain absent reason when a match is visible, a state is named, or not every match was described', async () => {
  const plain = 'expected element to be absent but found 2';
  const mixed = await evalElement(
    matching([{ visible: false }, { visible: true }]),
    { testid: 'x' },
    undefined,
    true,
    true,
  );
  expect(mixed.failureReason).toBe(plain);

  // The check already names a state: `hidden` would make the advice repeat the check, and any other
  // state would make it ask the caller to drop the condition they wrote.
  for (const state of [ElementState.HIDDEN, ElementState.CHECKED]) {
    const stated = await evalElement(
      matching([{ visible: false }, { visible: false }]),
      { testid: 'x' },
      state,
      true,
      true,
    );
    expect(stated.failureReason).toBe(plain);
  }

  // Two matches, one described: the undescribed one may be visible, so no hidden hint.
  const truncated = await evalElement(
    matching([{ visible: false }], 2),
    { testid: 'x' },
    undefined,
    true,
    true,
  );
  expect(truncated.failureReason).toBe(plain);
});
