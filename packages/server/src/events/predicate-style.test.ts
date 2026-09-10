import { describe, expect, it } from 'vitest';
import { PredicateKind, ReticleCommand, type CommandResult } from '@reticlehq/core';
import { parsePredicate } from './predicate-parse.js';
import { evaluatePredicate, type PredicateSession } from './predicate.js';
import { matchStyleValue, type StylePropertyWanted } from './predicate-style.js';
import type { Predicate } from './predicate-eval.js';
import { readsDomState } from '../honesty/already-true.js';
import { describeWaitTarget } from '../honesty/unsettled.js';
import { declaresDom } from './predicate-asks.js';

/**
 * A CSS design-system change cannot produce a verdict without a computed-style predicate.
 * Presence sees the same class before and after; `getComputedStyle` is what actually changed.
 */
const CARD: Predicate = {
  kind: PredicateKind.STYLE,
  query: { css: '.pro-card' },
  properties: {
    'background-color': 'rgb(255, 255, 255)',
    'box-shadow': { contains: '0px 1px 2px' },
  },
};

class StyleSession implements PredicateSession {
  constructor(
    private readonly reply: Record<string, unknown>,
    private readonly ok = true,
  ) {}

  elapsed(): number {
    return 0;
  }

  command(name: string, _args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name !== ReticleCommand.COMPUTED_STYLE) {
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
    }
    return Promise.resolve({
      kind: 'command_result',
      id: 'x',
      ok: this.ok,
      result: this.reply,
    });
  }

  eventsSince(): never[] {
    return [];
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

describe('the style predicate parses the shape a design-system change needs', () => {
  it('accepts exact colors and contains on compound values', () => {
    expect(parsePredicate(CARD)).toEqual(CARD);
  });

  it('accepts a regex on a compound value', () => {
    const parsed = parsePredicate({
      kind: PredicateKind.STYLE,
      query: { css: '.pro-card' },
      properties: { 'font-family': { matches: 'Inter' } },
    });
    expect(parsed).toEqual({
      kind: PredicateKind.STYLE,
      query: { css: '.pro-card' },
      properties: { 'font-family': { matches: 'Inter' } },
    });
  });

  it('lifts a flat css selector into query, the way element lifts a flat testid', () => {
    expect(
      parsePredicate({
        kind: PredicateKind.STYLE,
        css: '.pro-card',
        properties: { color: 'rgb(0, 0, 0)' },
      }),
    ).toEqual({
      kind: PredicateKind.STYLE,
      query: { css: '.pro-card' },
      properties: { color: 'rgb(0, 0, 0)' },
    });
  });

  it('still rejects putting css on an element query — that locator does not take it', () => {
    expect(() =>
      parsePredicate({ kind: PredicateKind.ELEMENT, query: { css: '.pro-card' } }),
    ).toThrow(/unknown field css|unrecognized/i);
  });
});

describe("matchStyleValue compares in the browser's normalised form", () => {
  it('passes an exact color', () => {
    expect(matchStyleValue('rgb(255, 255, 255)', 'rgb(255, 255, 255)')).toEqual({ pass: true });
  });

  it('fails an exact color and names both sides', () => {
    const r = matchStyleValue('rgb(0, 0, 0)', 'rgb(255, 255, 255)');
    expect(r.pass).toBe(false);
    expect(r.observed).toBe('rgb(0, 0, 0)');
    expect(r.expected).toBe('rgb(255, 255, 255)');
  });

  it('passes contains on a box-shadow', () => {
    const wanted: StylePropertyWanted = { contains: '0px 1px 2px' };
    expect(
      matchStyleValue('rgb(0, 0, 0) 0px 1px 2px 0px, rgb(0, 0, 0) 0px 1px 3px 1px', wanted).pass,
    ).toBe(true);
  });

  it('fails contains and names both sides', () => {
    const r = matchStyleValue('none', { contains: '0px 1px 2px' });
    expect(r.pass).toBe(false);
    expect(r.observed).toBe('none');
    expect(r.expected).toContain('0px 1px 2px');
  });

  it('passes a regex on font-family', () => {
    expect(matchStyleValue('Inter, system-ui, sans-serif', { matches: 'Inter' }).pass).toBe(true);
  });

  it('says so when the regex itself is unusable', () => {
    const r = matchStyleValue('Inter', { matches: '(' });
    expect(r.pass).toBe(false);
    expect(r.failureReason ?? '').toMatch(/regex|pattern/i);
  });
});

describe('evalStyle reads computed style, not the stylesheet text', () => {
  it('passes when the resolved properties hold', async () => {
    const session = new StyleSession({
      matched: true,
      count: 1,
      styles: {
        'background-color': 'rgb(255, 255, 255)',
        'box-shadow': 'rgb(0, 0, 0) 0px 1px 2px 0px',
      },
    });
    const r = await evaluatePredicate(session, CARD);
    expect(r.pass).toBe(true);
  });

  it('fails after a token change and names the property and both values', async () => {
    const session = new StyleSession({
      matched: true,
      count: 1,
      styles: {
        'background-color': 'rgb(15, 23, 42)',
        'box-shadow': 'none',
      },
    });
    const r = await evaluatePredicate(session, CARD);
    expect(r.pass).toBe(false);
    expect(r.failureReason ?? '').toContain('background-color');
    expect(r.failureReason ?? '').toContain('rgb(15, 23, 42)');
    expect(r.failureReason ?? '').toContain('rgb(255, 255, 255)');
    expect(r.assertion).toBe('style.background-color');
  });

  it('fails when the selector matches nothing', async () => {
    const session = new StyleSession({ matched: false, count: 0 });
    const r = await evaluatePredicate(session, CARD);
    expect(r.pass).toBe(false);
    expect(r.failureReason ?? '').toMatch(/no element matched/i);
    expect(r.failureReason ?? '').toContain('.pro-card');
  });
});

describe('style is live DOM, so act_and_wait must check it before the click', () => {
  it('readsDomState, or a pre-styled card is a false green', () => {
    expect(readsDomState(CARD)).toBe(true);
  });

  it('declaresDom, so a miss points at the node rather than the last click', () => {
    expect(declaresDom(CARD)).toBe(true);
  });

  it("names the wait in the caller's terms", () => {
    expect(describeWaitTarget(CARD)).toMatch(/style|\.pro-card/);
  });
});
