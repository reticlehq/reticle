/**
 * A `text` predicate that carries a property must judge the COMPLETE text under its scope.
 *
 * The browser describes every element with a display-bounded `text` (the first 80 characters and
 * an ellipsis), which is right for output an agent reads and wrong for a verdict. A consent legend
 * longer than that failed an exact `oneOf` and a `matchesPattern` anchored at its end, while a
 * role/name assertion on the same fieldset passed - the assertion was graded against a string the
 * page never showed. The session below does what the browser does: it bounds the text unless it is
 * asked for all of it, and even then stops at the full-text bound.
 */
import { describe, it, expect } from 'vitest';
import { ReticleCommand, TRANSPORT_LIMITS, type CommandResult } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate/predicate.js';
import { parsePredicate } from './predicate/predicate-parse.js';
import { captureBaselines } from '../evidence/baseline.js';

const DISPLAY_CAP = TRANSPORT_LIMITS.MAX_DESCRIBED_TEXT;

const LEGEND =
  'I agree to receive product updates, security notices and occasional offers by email, ' +
  'and I understand I can withdraw this consent at any time from my account settings. END-OF-LEGEND';

const SCOPE = '[data-testid="consent-legend"]';

class BoundedBrowser implements PredicateSession {
  readonly asked: Array<Record<string, unknown>> = [];
  constructor(public text: string) {}

  elapsed = (): number => 0;
  eventsSince = (): never[] => [];
  onEvent = (): (() => void) => () => undefined;

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name !== ReticleCommand.MATCH) {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    this.asked.push(args);
    const cap = true === args['fullText'] ? TRANSPORT_LIMITS.MAX_FULL_TEXT : DISPLAY_CAP;
    const shown = this.text.length <= cap ? this.text : `${this.text.slice(0, cap)}…`;
    return Promise.resolve({
      kind: 'command_result',
      id: 'x',
      ok: true,
      result: {
        matched: true,
        count: 1,
        elements: [{ ref: 'e1', role: 'group', name: '', text: shown, states: [], visible: true }],
      },
    } as CommandResult);
  }
}

const textSatisfies = (satisfies: Record<string, unknown>): ReturnType<typeof parsePredicate> =>
  parsePredicate({ kind: 'text', scope: SCOPE, self: true, satisfies });

const endsWith = (tail: string): Record<string, unknown> => ({
  property: 'matchesPattern',
  pattern: `${tail}$`,
});

describe('text { satisfies } reads the complete text, not the display-bounded one', () => {
  it('the legend really is longer than the display bound', () => {
    expect(LEGEND.length).toBeGreaterThan(DISPLAY_CAP);
  });

  it('matchesPattern anchored at the END of a long text holds', async () => {
    const result = await evaluatePredicate(
      new BoundedBrowser(LEGEND),
      textSatisfies(endsWith('END-OF-LEGEND')),
      0,
      false,
    );
    expect(result.pass).toBe(true);
  });

  it('oneOf the exact long text holds', async () => {
    const result = await evaluatePredicate(
      new BoundedBrowser(LEGEND),
      textSatisfies({ property: 'oneOf', values: [LEGEND] }),
      0,
      false,
    );
    expect(result.pass).toBe(true);
  });

  it('a long text that is genuinely different still fails', async () => {
    const result = await evaluatePredicate(
      new BoundedBrowser(LEGEND),
      textSatisfies(endsWith('NOT-THERE')),
      0,
      false,
    );
    expect(result.pass).toBe(false);
  });

  it('a change past the display bound is a change', async () => {
    const page = new BoundedBrowser(LEGEND);
    const predicate = textSatisfies({ property: 'changed' });
    const baselines = await captureBaselines(page, predicate);
    page.text = LEGEND.replace('END-OF-LEGEND', 'END-OF-AMENDED-LEGEND');

    const result = await evaluatePredicate(page, predicate, 0, false, baselines);

    expect(result.pass).toBe(true);
  });

  it('the match it returns is display-sized again, so judging more does not enlarge the verdict', async () => {
    const result = await evaluatePredicate(
      new BoundedBrowser(LEGEND),
      textSatisfies(endsWith('END-OF-LEGEND')),
      0,
      false,
    );
    const matched = (result.evidence as { matched: Array<{ text?: string }> }).matched;
    expect(matched[0]?.text).toBe(`${LEGEND.slice(0, DISPLAY_CAP)}…`);
  });
});

describe('a text longer than the full-text bound is declared, not guessed at', () => {
  it('is not graded, and says why', async () => {
    const tooLong = `${'x'.repeat(TRANSPORT_LIMITS.MAX_FULL_TEXT)}END`;
    // A pattern that would PASS on the part that was read: grading it would be a verdict on a guess.
    const result = await evaluatePredicate(
      new BoundedBrowser(tooLong),
      textSatisfies({ property: 'matchesPattern', pattern: '^x+' }),
      0,
      false,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain(String(TRANSPORT_LIMITS.MAX_FULL_TEXT));
  });

  it('a text exactly at the bound is whole, and is graded', async () => {
    const atBound = 'y'.repeat(TRANSPORT_LIMITS.MAX_FULL_TEXT);
    const result = await evaluatePredicate(
      new BoundedBrowser(atBound),
      textSatisfies({ property: 'oneOf', values: [atBound] }),
      0,
      false,
    );
    expect(result.pass).toBe(true);
  });
});

describe('only the readers that judge text ask for all of it', () => {
  it('a plain text presence check keeps the bounded descriptor', async () => {
    const page = new BoundedBrowser(LEGEND);
    await evaluatePredicate(
      page,
      parsePredicate({ kind: 'text', contains: 'consent', scope: SCOPE }),
      0,
      false,
    );
    expect(page.asked.length).toBeGreaterThan(0);
    expect(page.asked.every((args) => args['fullText'] === undefined)).toBe(true);
  });

  it('a failing property verdict quotes a bounded slice of a very long text', async () => {
    const long = `${'lorem ipsum '.repeat(300)}END`;
    const result = await evaluatePredicate(
      new BoundedBrowser(long),
      textSatisfies(endsWith('NOPE')),
      0,
      false,
    );
    expect(result.pass).toBe(false);
    expect(result.observed?.length ?? 0).toBeLessThan(600);
    expect(result.failureReason?.length ?? 0).toBeLessThan(600);
  });
});
