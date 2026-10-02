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
