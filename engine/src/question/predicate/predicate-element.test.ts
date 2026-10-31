import { expect, it } from 'vitest';
import { ElementState, PredicateKind, type ElementDescriptor, type Ref } from '@reticlehq/core';

import { ARIA_HIDDEN_NOTE, evalElement, HTML_TAG_TO_ARIA_ROLE } from './predicate-element.js';
import { waitForPredicate } from './predicate.js';
import { residualQueryChecks, satisfiesResiduals } from './predicate-schema.js';
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
    // The stub page answers with an error, which rejects; only the question being asked matters here.
    await expect(
      evalElement(current, { role: 'button', name: 'Bold' }, ElementState.PRESSED, false, false),
    ).rejects.toThrow('stub');
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

/** A page answering MATCH from a table of query → elements; anything else matches nothing. */
function pageWith(
  answers: (query: Record<string, unknown>) => unknown[] | undefined,
  hint?: unknown,
) {
  const s: PredicateSession = {
    ...session,
    command(_name, args) {
      const query = (args as { query: Record<string, unknown> }).query;
      const elements = answers(query) ?? [];
      return Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'm',
        result: {
          matched: elements.length > 0,
          count: elements.length,
          elements,
          ...(hint === undefined ? {} : { hint }),
        },
      });
    },
  };
  return s;
}

it('a role miss names the controls carrying that name under their real role — still a failure', async () => {
  const composer = {
    ref: 'e7',
    role: 'generic',
    name: 'Ask a question',
    states: [],
    visible: true,
  };
  const page = pageWith((q) => ('Ask a question' === q['label'] ? [composer] : undefined));
  const result = await evalElement(
    page,
    { role: 'textbox', name: 'Ask a question' },
    undefined,
    false,
    true,
  );
  expect(result.pass).toBe(false);
  expect(result.observed).toContain('generic "Ask a question" (e7)');
  expect(result.evidence).toEqual({ nearestByName: [composer] });
});

it('a case-only text miss says what would hold, and the verdict stays a failure', async () => {
  const page = pageWith(() => undefined, { caseMiss: 'Trial' });
  const result = await evalElement(
    page,
    { text: 'trial', matchCase: true },
    undefined,
    false,
    true,
  );
  expect(result.pass).toBe(false);
  expect(result.caseOnlyMiss).toBe(true);
  expect(result.wouldHold).toContain('ignoreCase: true');
  expect(result.wouldHold).toContain('Trial');
});

it('names the aria-hidden subtree when the hint says so (#1070)', async () => {
  const withHint: PredicateSession = {
    ...session,
    command: () =>
      Promise.resolve({
        kind: 'command_result' as const,
        id: 'x',
        ok: true,
        result: {
          matched: false,
          count: 0,
          elements: [],
          hint: {
            route: '/',
            presentTestids: [],
            presentRegions: [],
            knownEmptyState: false,
            ariaHiddenMatch: true,
          },
        },
      }),
  };
  const result = await evalElement(withHint, { text: 'Hello' }, undefined, false, true);
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain(ARIA_HIDDEN_NOTE);
});

it('does not blame aria-hidden when a visible element exists in the wrong state (#1070)', async () => {
  let call = 0;
  const stateSession: PredicateSession = {
    ...session,
    command: () => {
      call++;
      if (1 === call) {
        return Promise.resolve({
          kind: 'command_result' as const,
          id: 'x',
          ok: true,
          result: {
            matched: false,
            count: 0,
            elements: [],
            hint: {
              route: '/',
              presentTestids: [],
              presentRegions: [],
              knownEmptyState: false,
              ariaHiddenMatch: true,
            },
          },
        });
      }
      return Promise.resolve({
        kind: 'command_result' as const,
        id: 'x',
        ok: true,
        result: {
          matched: true,
          count: 1,
          elements: [{ ref: 'e1', role: 'button', name: 'Go', states: ['visible'], visible: true }],
        },
      });
    },
  };
  const result = await evalElement(
    stateSession,
    { role: 'button', name: 'Go' },
    ElementState.PRESSED,
    false,
    true,
  );
  expect(result.pass).toBe(false);
  expect(result.failureReason).not.toContain(ARIA_HIDDEN_NOTE);
});

it('tells the agent that iframe is not an ARIA role and names the correct role (#1696)', async () => {
  const page = pageWith(() => undefined);
  const result = await evalElement(page, { role: 'iframe' }, undefined, false, true);
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain("'iframe' is not an ARIA role");
  expect(result.failureReason).toContain("role 'generic'");
});

it('names the correct non-generic role when the tag maps to one (#1696)', async () => {
  const page = pageWith(() => undefined);
  const result = await evalElement(page, { role: 'nav' }, undefined, false, true);
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain("'nav' is not an ARIA role");
  expect(result.failureReason).toContain("role 'navigation'");
});

it('names the condition for section whose role depends on whether it is named (#1696)', async () => {
  const page = pageWith(() => undefined);
  const result = await evalElement(page, { role: 'section' }, undefined, false, true);
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain("'section' is not an ARIA role");
  expect(result.failureReason).toContain('named');
  expect(result.failureReason).toContain("'region'");
  expect(result.failureReason).toContain("'generic'");
});

it('HTML_TAG_TO_ARIA_ROLE covers the common mistakes and no non-rendered tags', () => {
  expect(HTML_TAG_TO_ARIA_ROLE.has('script')).toBe(false);
  expect(HTML_TAG_TO_ARIA_ROLE.has('style')).toBe(false);
  expect(HTML_TAG_TO_ARIA_ROLE.has('template')).toBe(false);
  expect(HTML_TAG_TO_ARIA_ROLE.has('iframe')).toBe(true);
  expect(HTML_TAG_TO_ARIA_ROLE.get('input')).toBe('textbox');
  expect(HTML_TAG_TO_ARIA_ROLE.get('nav')).toBe('navigation');
});

/**
 * A framework error dialog over the page (#1768). The text under it is in the DOM, but a user sees
 * only the dialog, so a presence check is unknown, never a plain `yes`, and the reason names it.
 */
it('is inconclusive, never a pass, when a framework error dialog covers the match', async () => {
  const covered: PredicateSession = {
    ...session,
    command: () =>
      Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'stub',
        result: {
          matched: true,
          count: 1,
          elements: [{ ref: 'e0', role: 'paragraph', name: '', states: [], visible: true }],
          coveredBy: 'Next.js error dialog',
        },
      }),
  };
  const result = await evalElement(covered, { text: 'Welcome back' }, undefined, false, true);
  expect(result.pass).toBe(false);
  expect(result.inconclusive).toContain('Next.js error dialog');
});

/**
 * Text a person cannot read (#1797). A cart total in the page background colour matched a text
 * check and passed. The text is in the DOM, but nobody can see it, so the check is never a `yes`.
 */
it('is inconclusive, never a pass, when the matched text is unreadable', async () => {
  const unreadable: PredicateSession = {
    ...session,
    command: () =>
      Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'stub',
        result: {
          matched: true,
          count: 1,
          elements: [{ ref: 'e0', role: 'paragraph', name: '', states: [], visible: true }],
          unreadable: 'text rgb(255, 255, 255) on rgb(255, 255, 255): contrast 1.00:1',
        },
      }),
  };
  const result = await evalElement(unreadable, { text: 'Total: $50' }, undefined, false, true);
  expect(result.pass).toBe(false);
  expect(result.inconclusive).toContain('contrast 1.00:1');
  expect(result.assertion).toBe('element.readable');
});

/**
 * A page that declared its commands and left match out can never answer one (#1990): the session
 * refuses the send, and that refusal used to be read as "zero matches". The refusal now names the
 * SDK and the fix, and is not awaited.
 */
it('refuses a match the page does not serve, without asking the page', async () => {
  let asked = false;
  const old: PredicateSession = {
    ...session,
    sdkVersion: '3.8.2',
    commands: ['snapshot', 'query'],
    command() {
      asked = true;
      return Promise.resolve({ kind: 'command_result', ok: false, id: 'stub', error: 'stub' });
    },
  };
  await expect(
    evalElement(old, { role: 'button', name: 'Save' }, undefined, false, true),
  ).rejects.toThrow(/3\.8\.2.*does not serve 'match'.*reticle update/s);
  expect(asked).toBe(false);
  // An SDK too old to declare anything says nothing: silence is unknown, never "serves nothing".
  const silent: PredicateSession = { ...old, commands: undefined };
  await expect(
    evalElement(silent, { role: 'button', name: 'Save' }, undefined, false, false),
  ).rejects.toThrow('stub');
  expect(asked).toBe(true);
});

/**
 * A match the page answered with an error never looked at the page. It is not "zero matches".
 *
 * Reported on 3.9.0: `{ kind: "text", contains: "problems to fix", visible: true }` came back
 * `no`, "no element matched", while `reticle_look` showed that text. The same markup matches in
 * the page's own matcher. The engine read a failed `match` reply as an empty match, so any page
 * error (a query the page's schema refuses, a matcher that threw) became a false `no`.
 */
it('reads a match the page answered with an error as unknown, never as no match', async () => {
  const PAGE_ERROR = "Unrecognized key(s) in object: 'matchCase'";
  const failing: PredicateSession = {
    ...session,
    command: () =>
      Promise.resolve({ kind: 'command_result', ok: false, id: 'stub', error: PAGE_ERROR }),
  };
  const query = { text: 'problems to fix', matchCase: true };
  await expect(evalElement(failing, query, ElementState.VISIBLE, false, true)).rejects.toThrow(
    PAGE_ERROR,
  );
  const scoped = { ...query, scope: '[data-testid=fixes-summary]' };
  await expect(evalElement(failing, scoped, undefined, false, false)).rejects.toThrow(PAGE_ERROR);
  // The verdict path turns a read that threw into `inconclusive`, so the answer is unknown.
  const waited = await waitForPredicate(
    failing,
    { kind: PredicateKind.TEXT, contains: 'problems to fix', visible: true },
    0,
  );
  expect(waited.pass).toBe(false);
  expect(waited.inconclusive).toContain(PAGE_ERROR);
  expect(waited.failureReason).not.toContain('no element matched');
});

/** An ok reply that carries no result also never said what the page holds. It is not "zero matches". */
it('reads an ok match reply with no result as unknown, never as no match', async () => {
  const empty: PredicateSession = {
    ...session,
    command: () => Promise.resolve({ kind: 'command_result', ok: true, id: 'stub' }),
  };
  await expect(
    evalElement(empty, { text: 'problems to fix' }, ElementState.VISIBLE, false, true),
  ).rejects.toThrow("could not answer 'match'");
  const waited = await waitForPredicate(
    empty,
    { kind: PredicateKind.TEXT, contains: 'problems to fix', visible: true },
    0,
  );
  expect(waited.pass).toBe(false);
  expect(waited.inconclusive).toBeDefined();
  expect(waited.failureReason ?? '').not.toContain('no element matched');
});

/**
 * One name rule, whichever locator carries the check (#1839).
 *
 * Sent with `role`, a name check runs in the browser through `exactVisibleText`, which trims,
 * collapses inner whitespace and compares in NFC. Sent with `testid`, the browser drops `name`
 * and the engine enforces it back here - which compared with trim alone. An accessible name
 * carrying an inner line break (aria-label="Save\nDraft") matched the first way and missed the
 * second, so the same check flipped its answer with the locator that carried it. The residual
 * check now applies the same rule.
 */
it('compares a dropped name under the same whitespace rule the browser applies (#1839)', () => {
  const { checks } = residualQueryChecks({ by: 'testid', value: 'save-btn', name: 'Save Draft' });
  expect(checks).toContainEqual(['name', 'Save Draft']);
  const named = (name: string): ElementDescriptor => ({
    ref: 'e1' as Ref,
    role: 'button',
    name,
    states: [],
    visible: true,
  });

  // An inner line break or doubled space is one name, whichever locator carried the check.
  expect(satisfiesResiduals(named('Save\nDraft'), checks)).toBe(true);
  expect(satisfiesResiduals(named('  Save  Draft '), checks)).toBe(true);
  // The rule stays exact: a different name or part of one still does not match.
  expect(satisfiesResiduals(named('Save All'), checks)).toBe(false);
  expect(satisfiesResiduals(named('Save Draft Now'), checks)).toBe(false);
});

/**
 * A page that reports no SDK version is sent `matchCase`, and an SDK older than 3.7.0 refuses the
 * whole query for that key. Since #2041 that refusal grades unknown, so a text the page shows
 * verbatim never got a verdict. The engine now asks once more without `matchCase` and checks the
 * case on the text the page returns.
 */
const MATCH_CASE_REFUSAL = "Unrecognized key(s) in object: 'matchCase'";

function caseBlindPage(
  texts: readonly string[],
  refusal = MATCH_CASE_REFUSAL,
): { page: PredicateSession; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const page: PredicateSession = {
    ...session,
    command(_name, args) {
      const query = (args as { query: Record<string, unknown> }).query;
      sent.push(query);
      if ('matchCase' in query) {
        return Promise.resolve({ kind: 'command_result', ok: false, id: 'stub', error: refusal });
      }
      const needle = String(query.text).toLowerCase();
      const elements = texts
        .filter((text) => text.toLowerCase().includes(needle))
        .map((text, i) => ({
          ref: `e${String(i)}`,
          role: 'paragraph',
          name: '',
          text,
          states: [],
          visible: true,
        }));
      return Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'stub',
        result: { matched: elements.length > 0, count: elements.length, elements },
      });
    },
  };
  return { page, sent };
}

it('grades a text predicate on an unversioned SDK that refuses matchCase', async () => {
  const { page, sent } = caseBlindPage(['You have 3 problems to fix']);
  const waited = await waitForPredicate(
    page,
    { kind: PredicateKind.TEXT, contains: 'problems to fix', visible: true },
    0,
  );
  expect(waited.inconclusive).toBeUndefined();
  expect(waited.pass).toBe(true);
  expect(sent).toHaveLength(2);
  expect(sent[1]).not.toHaveProperty('matchCase');
});

it('keeps the check case-exact when the SDK refuses matchCase', async () => {
  const { page } = caseBlindPage(['Saved priya']);
  const waited = await waitForPredicate(
    page,
    { kind: PredicateKind.TEXT, contains: 'Saved Priya', visible: true },
    0,
  );
  expect(waited.inconclusive).toBeUndefined();
  expect(waited.pass).toBe(false);
  // ignoreCase still matches the same page.
  const blind = await waitForPredicate(
    page,
    { kind: PredicateKind.TEXT, contains: 'Saved Priya', ignoreCase: true },
    0,
  );
  expect(blind.pass).toBe(true);
});

it('does not retry a refusal that is not about matchCase', async () => {
  const OTHER = 'the matcher threw: boom';
  const { page, sent } = caseBlindPage(['problems to fix'], OTHER);
  const waited = await waitForPredicate(
    page,
    { kind: PredicateKind.TEXT, contains: 'problems to fix', visible: true },
    0,
  );
  expect(waited.pass).toBe(false);
  expect(waited.inconclusive).toContain(OTHER);
  expect(sent).toHaveLength(1);
});

it('sends matchCase once to a modern SDK and does not retry', async () => {
  const sent: Record<string, unknown>[] = [];
  const modern: PredicateSession = {
    ...session,
    sdkVersion: '3.9.0',
    command(_name, args) {
      sent.push((args as { query: Record<string, unknown> }).query);
      const elements = [
        { ref: 'e0', role: 'paragraph', name: '', text: 'Saved Priya', states: [], visible: true },
      ];
      return Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'stub',
        result: { matched: true, count: 1, elements },
      });
    },
  };
  const waited = await waitForPredicate(
    modern,
    { kind: PredicateKind.TEXT, contains: 'Saved Priya' },
    0,
  );
  expect(waited.pass).toBe(true);
  expect(sent).toEqual([{ text: 'Saved Priya', matchCase: true }]);
});
