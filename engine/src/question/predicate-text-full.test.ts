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
import { MatchArg, ReticleCommand, TRANSPORT_LIMITS, type CommandResult } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate/predicate.js';
import { parsePredicate } from './predicate/predicate-parse.js';
import { captureBaselines } from '../evidence/baseline.js';

const DISPLAY_CAP = TRANSPORT_LIMITS.MAX_DESCRIBED_TEXT;

const LEGEND =
  'I agree to receive product updates, security notices and occasional offers by email, ' +
  'and I understand I can withdraw this consent at any time from my account settings. END-OF-LEGEND';

const SCOPE = '[data-testid="consent-legend"]';

interface Page {
  /** A page too old to know `fullText` ignores it and never echoes it. */
  readonly oldSdk?: boolean;
  /** How many elements matched, when more than were described. */
  readonly matchedTotal?: number;
  /** The text under each scope, for a predicate that reads two of them. Other scopes get `text`. */
  readonly byScope?: Readonly<Record<string, string>>;
}

class BoundedBrowser implements PredicateSession {
  readonly asked: Array<Record<string, unknown>> = [];
  constructor(
    public text: string,
    private readonly page: Page = {},
  ) {}

  elapsed = (): number => 0;
  eventsSince = (): never[] => [];
  onEvent = (): (() => void) => () => undefined;

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name !== ReticleCommand.MATCH) {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    this.asked.push(args);
    const honoured = true === args[MatchArg.FULL_TEXT] && true !== this.page.oldSdk;
    const cap = honoured ? TRANSPORT_LIMITS.MAX_FULL_TEXT : DISPLAY_CAP;
    const scope = (args['query'] as { scope?: string } | undefined)?.scope ?? '';
    const text = this.page.byScope?.[scope] ?? this.text;
    const shown = text.length <= cap ? text : `${text.slice(0, cap)}…`;
    return Promise.resolve({
      kind: 'command_result',
      id: 'x',
      ok: true,
      result: {
        matched: true,
        count: this.page.matchedTotal ?? 1,
        elements: [{ ref: 'e1', role: 'group', name: '', text: shown, states: [], visible: true }],
        ...(honoured ? { fullText: true } : {}),
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

describe('a reading that is not the whole text is declared, not guessed at', () => {
  it('a text cut at the full-text bound is not graded, and says why', async () => {
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

  it('a page whose SDK predates the argument is not graded on the short text it sent back', async () => {
    // It ignored `fullText` and answered with 80 characters: a pattern that holds for those 80
    // would pass, and the same pattern on the real text might not.
    const result = await evaluatePredicate(
      new BoundedBrowser(LEGEND, { oldSdk: true }),
      textSatisfies({ property: 'matchesPattern', pattern: '^I agree' }),
      0,
      false,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('SDK');
  });

  it('more elements matched than were read in full is not graded on the ones that were', async () => {
    const result = await evaluatePredicate(
      new BoundedBrowser(LEGEND, { matchedTotal: 80 }),
      textSatisfies({ property: 'matchesPattern', pattern: '^I agree' }),
      0,
      false,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('80 elements matched');
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
    expect(page.asked.every((args) => args[MatchArg.FULL_TEXT] === undefined)).toBe(true);
  });

  it('an absence check does not ask for full text, so a failed one cannot carry it out', async () => {
    const page = new BoundedBrowser(LEGEND);
    const result = await evaluatePredicate(
      page,
      parsePredicate({
        kind: 'text',
        scope: SCOPE,
        self: true,
        absent: true,
        satisfies: { property: 'nonEmpty' },
      }),
      0,
      false,
    );
    expect(page.asked.every((args) => args[MatchArg.FULL_TEXT] === undefined)).toBe(true);
    const shown = JSON.stringify(result.evidence ?? []);
    expect(shown).not.toContain('END-OF-LEGEND');
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

describe('compare reads a text side whole, not the display-bounded form', () => {
  const LEFT = '[data-testid="shown"]';
  const RIGHT = '[data-testid="answered"]';
  const OPENING =
    'The refund was issued to the original payment method and should appear on the statement ' +
    'within five to ten business days, ';

  const compareTexts = (as?: 'number'): ReturnType<typeof parsePredicate> =>
    parsePredicate({
      kind: 'compare',
      left: { from: 'text', scope: LEFT },
      right: { from: 'text', scope: RIGHT },
      ...(undefined === as ? {} : { as }),
    });

  const page = (left: string, right: string, extra: Page = {}): BoundedBrowser =>
    new BoundedBrowser('', { ...extra, byScope: { [LEFT]: left, [RIGHT]: right } });

  it('the opening really is longer than the display bound', () => {
    expect(OPENING.length).toBeGreaterThan(DISPLAY_CAP);
  });

  it('two texts that differ only after the display bound are different', async () => {
    const browser = page(`${OPENING}11.87`, `${OPENING}1187.01`);
    const result = await evaluatePredicate(browser, compareTexts(), 0, false);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
    expect(result.assertion).toBe('compare.value');
    expect(browser.asked.every((args) => true === args[MatchArg.FULL_TEXT])).toBe(true);
  });

  it('two long texts that are the same still agree', async () => {
    const result = await evaluatePredicate(
      page(`${OPENING}11.87`, `${OPENING}11.87`),
      compareTexts(),
      0,
      false,
    );
    expect(result.pass).toBe(true);
  });

  it('a number past the display bound is the number compared', async () => {
    const differ = await evaluatePredicate(
      page(`${OPENING}11.87`, `${OPENING}1187.01`),
      compareTexts('number'),
      0,
      false,
    );
    expect(differ.pass).toBe(false);
    expect(differ.inconclusive).toBeUndefined();
    expect(differ.assertion).toBe('compare.number');

    const agree = await evaluatePredicate(
      page(`${OPENING}11.87`, `${OPENING}11.87`),
      compareTexts('number'),
      0,
      false,
    );
    expect(agree.pass).toBe(true);
  });

  it('a side cut at the full-text bound is not compared, and says why', async () => {
    // Both read the same 4000 characters and differ only in what was not read: equal would be a guess.
    const head = 'x'.repeat(TRANSPORT_LIMITS.MAX_FULL_TEXT);
    const result = await evaluatePredicate(page(`${head}A`, `${head}B`), compareTexts(), 0, false);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain(String(TRANSPORT_LIMITS.MAX_FULL_TEXT));
  });

  it('a page whose SDK predates the argument is not compared on the short text it sent back', async () => {
    const result = await evaluatePredicate(
      page(`${OPENING}11.87`, `${OPENING}1187.01`, { oldSdk: true }),
      compareTexts(),
      0,
      false,
    );
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('SDK');
  });

  it('a failing comparison quotes a bounded slice of each text, and says when the slices agree', async () => {
    const long = 'lorem ipsum '.repeat(300);
    const result = await evaluatePredicate(
      page(`${long}END-A`, `${long}END-B`),
      compareTexts(),
      0,
      false,
    );
    expect(result.pass).toBe(false);
    expect(result.failureReason).toContain('differ further on');
    expect(result.failureReason?.length ?? 0).toBeLessThan(700);
    expect(result.observed?.length ?? 0).toBeLessThan(700);
    expect(JSON.stringify(result.evidence ?? {}).length).toBeLessThan(1000);
  });
});
