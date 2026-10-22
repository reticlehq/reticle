import { expect, it } from 'vitest';
import { ElementState } from '@reticlehq/core';

import { ARIA_HIDDEN_NOTE, evalElement, HTML_TAG_TO_ARIA_ROLE } from './predicate-element.js';
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
 * Geometry asks (#1539): the page measures, this side grades.
 *
 * The descriptor carries the measured box, the viewport, and the overflow amounts; the verdict and
 * its failure message are decided here. A page that reports no geometry measured nothing, so the
 * result is inconclusive rather than a guess in either direction.
 */
function withGeometry(geometry: object | undefined, count = 1): PredicateSession {
  return {
    ...session,
    command: () =>
      Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'stub',
        result: {
          matched: true,
          count,
          elements: [
            {
              ref: 'e1',
              role: 'button',
              name: 'Save',
              states: [],
              visible: true,
              ...(geometry === undefined ? {} : { geometry }),
            },
          ],
        },
      }),
  };
}

const FULL_BOX = {
  box: { x: 10, y: 10, width: 200, height: 50 },
  viewport: { width: 800, height: 600 },
  fullyInViewport: true,
  textClipped: false,
  clippedX: 0,
  clippedY: 0,
};

it('passes fullyInViewport when the page reports the whole box inside', async () => {
  const result = await evalElement(
    withGeometry(FULL_BOX),
    { testid: 'card' },
    undefined,
    false,
    true,
    { fullyInViewport: true },
  );
  expect(result.pass).toBe(true);
});

it('fails fullyInViewport with the measured box and viewport when part is outside', async () => {
  const result = await evalElement(
    withGeometry({ ...FULL_BOX, fullyInViewport: false }),
    { testid: 'card' },
    undefined,
    false,
    true,
    { fullyInViewport: true },
  );
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain('200');
  expect(result.failureReason).toContain('800');
});

it('fails a textClipped: false ask with the overflow amounts', async () => {
  const result = await evalElement(
    withGeometry({ ...FULL_BOX, textClipped: true, clippedX: 24, clippedY: 0 }),
    { testid: 'card' },
    undefined,
    false,
    true,
    { textClipped: false },
  );
  expect(result.pass).toBe(false);
  expect(result.failureReason).toContain('24');
});

it('grades overlaps from the reported boxes', async () => {
  const apart = await evalElement(
    withGeometry({
      ...FULL_BOX,
      overlap: { intersects: false, box: { x: 400, y: 300, width: 100, height: 40 } },
    }),
    { testid: 'card' },
    undefined,
    false,
    true,
    { overlaps: { testid: 'other' } },
  );
  expect(apart.pass).toBe(false);
  expect(apart.failureReason).toContain('400');

  const touching = await evalElement(
    withGeometry({
      ...FULL_BOX,
      overlap: { intersects: true, box: { x: 100, y: 20, width: 100, height: 40 } },
    }),
    { testid: 'card' },
    undefined,
    false,
    true,
    { overlaps: { testid: 'other' } },
  );
  expect(touching.pass).toBe(true);
});

it('is inconclusive when the page reported no geometry', async () => {
  const result = await evalElement(
    withGeometry(undefined),
    { testid: 'card' },
    undefined,
    false,
    true,
    { fullyInViewport: true },
  );
  expect(result.pass).toBe(false);
  expect(result.inconclusive).toBeDefined();
});

it('is inconclusive when more elements matched than were described', async () => {
  // Review case on #1635: `elements` is the described prefix of `count`. Grading the prefix
  // under `not` could pass while an undescribed element satisfies the ask, so the locator
  // must be narrowed first, the same as for the other post-match checks.
  const result = await evalElement(
    withGeometry(FULL_BOX, 2),
    { testid: 'card' },
    undefined,
    false,
    true,
    { fullyInViewport: true },
  );
  expect(result.pass).toBe(false);
  expect(result.inconclusive).toBeDefined();
  expect(result.inconclusive).toContain('Narrow the locator');
});

it('is inconclusive when the overlaps query matched no visible element', async () => {
  // Review case on #1635: `not { element: card, overlaps: { testid: "typo" } }` must not pass.
  // A missing target is a different fact from boxes not intersecting, and `not` propagates
  // inconclusive instead of negating it — a plain failure here would become a wrong pass.
  const result = await evalElement(
    withGeometry(FULL_BOX),
    { testid: 'card' },
    undefined,
    false,
    true,
    { overlaps: { testid: 'typo' } },
  );
  expect(result.pass).toBe(false);
  expect(result.inconclusive).toBeDefined();
  expect(result.inconclusive).toContain('typo');
});

it('is inconclusive when geometry asks are present and the locator matched nothing', async () => {
  // Review case on #1635: the geometry check ran only on a match, so a locator that matched
  // nothing stayed a plain miss, and `not` turned that miss into a pass. A missing element
  // has no box to measure, so the answer is inconclusive, never a plain failure.
  const noMatch: PredicateSession = {
    ...session,
    command: () =>
      Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'stub',
        result: { matched: false, count: 0, elements: [] },
      }),
  };
  const result = await evalElement(noMatch, { testid: 'typo' }, undefined, false, true, {
    overlaps: { testid: 'other' },
  });
  expect(result.pass).toBe(false);
  expect(result.inconclusive).toBeDefined();
  expect(result.inconclusive).toContain('typo');
});

it('refuses geometry asks combined with absent: true', async () => {
  // Review case on #1635: the absent branch returns before checkGeometry, so the asks would be
  // silently ignored. Refuse the combination instead of answering a question nobody asked.
  const result = await evalElement(
    withGeometry(FULL_BOX),
    { testid: 'card' },
    undefined,
    true,
    true,
    { fullyInViewport: true },
  );
  expect(result.pass).toBe(false);
  expect(result.inconclusive).toBeDefined();
});
