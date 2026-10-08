/**
 * `alt` next to a locator that does not read it must be CHECKED, not refused.
 *
 * Reported by an agent: `{ kind: "element", query: { testid: "hero-image", alt: "Product photo" } }`
 * was refused with "the element locator ignores `alt`", and so was `scope` + `self` + `alt`. The
 * locator resolves by the first of its fields that is present, so with a `testid` the `alt` is left
 * over — and `alt` had no entry in the residual checks, so there was nothing to verify it with.
 *
 * The check reads the image's `alt` attribute, projected onto the match, rather than its accessible
 * name: a decorative `alt=""` and a missing alt both have an empty name, and only one is correct. The one thing that must stay refused is a non-image: a
 * button has no alt, and answering "no" for it would read as "the alt is wrong" when the truth is
 * "this is not an image".
 */
import { describe, it, expect } from 'vitest';
import {
  asRef,
  ReticleCommand,
  type CommandResult,
  type ElementDescriptor,
  type MatchResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate/predicate.js';

/** An image whose `alt` attribute is its name unless `attrs` says otherwise (`{}` = no alt at all). */
function img(over: Partial<ElementDescriptor> = {}): ElementDescriptor {
  const name = over.name ?? 'Product photo';
  return {
    ref: asRef('r1'),
    role: 'img',
    name,
    states: [],
    visible: true,
    attrs: { alt: name },
    ...over,
  };
}

/** The browser projects an attribute only when the query asks for it, so this fake does too. */
function projected(element: ElementDescriptor, wanted: readonly string[]): ElementDescriptor {
  const attrs = Object.entries(element.attrs ?? {}).filter(([key]) => wanted.includes(key));
  const { attrs: _dropped, ...rest } = element;
  return 0 === attrs.length ? rest : { ...rest, attrs: Object.fromEntries(attrs) };
}

/** Answers MATCH with a fixed element list, whatever the query — the locator half is not under test. */
class MatchingSession implements PredicateSession {
  /** `total` is every match; `elements` is only the described prefix, which the browser cuts. */
  constructor(
    private readonly elements: ElementDescriptor[],
    private readonly total: number = elements.length,
  ) {}
  command(name: string, args?: unknown): Promise<CommandResult> {
    const wanted = (args as { query?: { attrs?: string[] } } | undefined)?.query?.attrs ?? [];
    const result: MatchResult | undefined =
      name === ReticleCommand.MATCH
        ? {
            matched: this.elements.length > 0,
            count: this.total,
            elements: this.elements.map((element) => projected(element, wanted)),
          }
        : undefined;
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
  }
  eventsSince(): ReticleEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 0;
  }
}

describe('element predicate: alt beside a locator that does not read it', () => {
  it('passes on an image whose alt matches', async () => {
    const result = await evaluatePredicate(new MatchingSession([img()]), {
      kind: 'element',
      query: { testid: 'hero-image', alt: 'Product photo' },
    });
    expect(result.pass).toBe(true);
    expect(result.inconclusive).toBeUndefined();
  });

  it('grades no, with the alt it found, when the alt differs', async () => {
    const result = await evaluatePredicate(new MatchingSession([img({ name: 'Old photo' })]), {
      kind: 'element',
      query: { testid: 'hero-image', alt: 'Product photo' },
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive, 'a mismatch is an answer, not a refusal').toBeUndefined();
    expect(result.assertion).toBe('element.alt');
    expect(result.observed).toContain('Old photo');
  });

  it('works with `scope` + `self`, the other spelling the report named', async () => {
    const result = await evaluatePredicate(new MatchingSession([img()]), {
      kind: 'element',
      query: { scope: '[data-testid="hero-image"]', self: true, alt: 'Product photo' },
    });
    expect(result.pass).toBe(true);
    expect(result.inconclusive).toBeUndefined();
  });

  it('compares trimmed, as `name` does', async () => {
    const result = await evaluatePredicate(new MatchingSession([img({ name: 'Product photo' })]), {
      kind: 'element',
      query: { testid: 'hero-image', alt: '  Product photo ' },
    });
    expect(result.pass).toBe(true);
  });

  it('an empty alt asserts the image is decorative', async () => {
    const decorative = new MatchingSession([img({ name: '' })]);
    const described = new MatchingSession([img()]);
    const query = { testid: 'hero-image', alt: '' };
    expect((await evaluatePredicate(decorative, { kind: 'element', query })).pass).toBe(true);
    expect((await evaluatePredicate(described, { kind: 'element', query })).pass).toBe(false);
  });

  it('an image with NO alt attribute is not decorative: `alt: ""` fails on it', async () => {
    // Both report role img and an empty name. Only the attribute tells them apart, and a missing alt
    // is the accessibility defect an empty-alt check exists to rule out.
    const missing = new MatchingSession([img({ name: '', attrs: {} })]);
    const result = await evaluatePredicate(missing, {
      kind: 'element',
      query: { testid: 'hero-image', alt: '' },
    });
    expect(result.pass).toBe(false);
    expect(result.observed).toContain('no alt attribute');
  });

  it('reads the alt attribute, not an aria-label that overrides the name', async () => {
    const labelled = img({ name: 'Hero banner', attrs: { alt: 'Product photo' } });
    const result = await evaluatePredicate(new MatchingSession([labelled]), {
      kind: 'element',
      query: { testid: 'hero-image', alt: 'Product photo' },
    });
    expect(result.pass).toBe(true);
  });

  it('absent: an image with a different alt satisfies an absence check', async () => {
    const result = await evaluatePredicate(new MatchingSession([img({ name: 'Old photo' })]), {
      kind: 'element',
      query: { testid: 'hero-image', alt: 'Product photo' },
      absent: true,
    });
    expect(result.pass).toBe(true);
  });

  it('is still refused on a non-image, and the refusal points at `name`', async () => {
    const button = img({ role: 'button', name: 'Product photo' });
    const result = await evaluatePredicate(new MatchingSession([button]), {
      kind: 'element',
      query: { testid: 'buy-now', alt: 'Product photo' },
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive, 'a button has no alt: that is no verdict, not a "no"').toContain(
      'alt',
    );
    expect(result.inconclusive).toContain('name');
    expect(result.inconclusive).toContain('button');
  });

  it('absent: a non-image is refused too, never counted as an absence of that alt', async () => {
    // A button cannot have the alt, so "no element with this alt" would be trivially true of it — and
    // that is the false green the refusal exists to prevent.
    const button = img({ role: 'button', name: 'Product photo' });
    const result = await evaluatePredicate(new MatchingSession([button]), {
      kind: 'element',
      query: { testid: 'buy-now', alt: 'Product photo' },
      absent: true,
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('name');
  });

  it('says to narrow the locator, not "not an image", when the match set was cut off', async () => {
    // Only a prefix of the matches is described. If that prefix is all buttons, an image may still
    // sit later in the set — so claiming "none of these is an image" would be a guess.
    const prefix = [img({ role: 'button', name: 'A' }), img({ role: 'button', name: 'B' })];
    const result = await evaluatePredicate(new MatchingSession(prefix, 5), {
      kind: 'element',
      query: { testid: 'gallery', alt: 'Product photo' },
    });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('narrow the locator');
    expect(result.inconclusive, 'it must not claim the matches are not images').not.toContain(
      'can only be checked on an image',
    );
  });

  it('judges the images when the locator also matched something that is not one', async () => {
    const result = await evaluatePredicate(
      new MatchingSession([img({ role: 'button', name: 'Product photo' }), img()]),
      { kind: 'element', query: { testid: 'gallery', alt: 'Product photo' } },
    );
    expect(result.pass).toBe(true);
  });

  it('leaves an `alt` the locator itself uses alone', async () => {
    const result = await evaluatePredicate(new MatchingSession([img()]), {
      kind: 'element',
      query: { alt: 'Product photo' },
    });
    expect(result.pass).toBe(true);
    expect(result.inconclusive).toBeUndefined();
  });
});
