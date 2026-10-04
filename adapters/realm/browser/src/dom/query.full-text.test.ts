/**
 * A MATCH describes text at display size unless the caller asks for all of it.
 *
 * A `text` predicate's property is judged on the descriptor's `text`, so the 80-character display
 * form made any longer text impossible to assert on. `fullText` is the caller saying it will JUDGE
 * the text, not show it: the descriptor then carries up to the full-text bound, and a text beyond
 * that is cut with an ellipsis so the consumer can tell it from a whole one.
 */
import { describe as suite, it, expect, beforeEach } from 'vitest';
import { TRANSPORT_LIMITS } from '@reticlehq/core';
import { matchQuery } from './query.js';

const LEGEND =
  'I agree to receive product updates, security notices and occasional offers by email, ' +
  'and I understand I can withdraw this consent at any time from my account settings. END-OF-LEGEND';

const SCOPED = { scope: '[data-testid="legend"]', self: true } as const;

function render(text: string): void {
  document.body.innerHTML = `<div data-testid="legend">${text}</div>`;
}

const textOf = (result: ReturnType<typeof matchQuery>): string | undefined =>
  result.elements[0]?.text;

beforeEach(() => {
  document.body.innerHTML = '';
});

suite('matchQuery describes text at display size by default', () => {
  it('cuts a long text to the display bound and an ellipsis', () => {
    render(LEGEND);
    expect(textOf(matchQuery(SCOPED))).toBe(
      `${LEGEND.slice(0, TRANSPORT_LIMITS.MAX_DESCRIBED_TEXT)}…`,
    );
  });
});

suite('matchQuery with fullText describes the whole text', () => {
  it('returns a text longer than the display bound intact', () => {
    render(LEGEND);
    expect(textOf(matchQuery(SCOPED, undefined, undefined, undefined, undefined, true))).toBe(
      LEGEND,
    );
  });

  it('still cuts a text beyond the full-text bound, and the cut is detectable', () => {
    const huge = 'z'.repeat(TRANSPORT_LIMITS.MAX_FULL_TEXT + 500);
    render(huge);
    const text = textOf(matchQuery(SCOPED, undefined, undefined, undefined, undefined, true)) ?? '';
    expect(text).toBe(`${'z'.repeat(TRANSPORT_LIMITS.MAX_FULL_TEXT)}…`);
    expect(text.length).toBeGreaterThan(TRANSPORT_LIMITS.MAX_FULL_TEXT);
  });

  it('leaves a text exactly at the full-text bound whole', () => {
    const atBound = 'q'.repeat(TRANSPORT_LIMITS.MAX_FULL_TEXT);
    render(atBound);
    expect(textOf(matchQuery(SCOPED, undefined, undefined, undefined, undefined, true))).toBe(
      atBound,
    );
  });
});
