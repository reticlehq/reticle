import { describe, expect, it } from 'vitest';
import { PredicateSchema, predicateShapeFor } from './predicate.js';
import { PRESENCE_GRADED, PredicateKind } from './consequence.js';
import { ChannelId, channelsReadBy } from '@/wire/channel.js';

/**
 * `{ kind: "head" }` asserts on a `<link>` or `<meta>` in the document's `<head>` (#1425).
 *
 * "Add a favicon / a meta description / a canonical link" is a common change, and no predicate could
 * check it: every element locator matches by testid, role, text, label, placeholder or alt, and a
 * head element has none of them. Narrow on purpose — one `link` by `rel`, or one `meta` by `name` or
 * `property` — because a general CSS selector locator is a much bigger surface than the ask.
 */
const parses = (input: unknown): boolean => PredicateSchema.safeParse(input).success;
const refusal = (input: unknown): string => {
  const result = PredicateSchema.safeParse(input);
  return result.success ? '' : result.error.issues.map((i) => i.message).join(' | ');
};

describe('the head predicate shape', () => {
  it('accepts a link by rel, with or without an href check', () => {
    expect(parses({ kind: 'head', link: { rel: 'icon' } })).toBe(true);
    expect(parses({ kind: 'head', link: { rel: 'icon' }, href: { contains: 'icon.svg' } })).toBe(
      true,
    );
    expect(
      parses({ kind: 'head', link: { rel: 'canonical' }, href: { equals: 'https://a.test/' } }),
    ).toBe(true);
  });

  it('accepts a meta by name or by property, with or without a content check', () => {
    expect(parses({ kind: 'head', meta: { name: 'description' } })).toBe(true);
    expect(
      parses({ kind: 'head', meta: { name: 'description' }, content: { contains: 'Plan' } }),
    ).toBe(true);
    expect(
      parses({ kind: 'head', meta: { property: 'og:image' }, content: { contains: '.png' } }),
    ).toBe(true);
  });

  it('accepts absent, for a tag that must not be there', () => {
    expect(
      parses({
        kind: 'head',
        meta: { name: 'robots' },
        content: { contains: 'noindex' },
        absent: true,
      }),
    ).toBe(true);
  });

  it('refuses a head predicate that names neither a link nor a meta', () => {
    expect(refusal({ kind: 'head' })).toMatch(/exactly one of `link` or `meta`/);
  });

  it('refuses one that names both', () => {
    expect(refusal({ kind: 'head', link: { rel: 'icon' }, meta: { name: 'description' } })).toMatch(
      /exactly one of `link` or `meta`/,
    );
  });

  it('refuses a meta that names neither or both of name and property', () => {
    expect(refusal({ kind: 'head', meta: {} })).toMatch(/exactly one of `name` or `property`/);
    expect(refusal({ kind: 'head', meta: { name: 'a', property: 'b' } })).toMatch(
      /exactly one of `name` or `property`/,
    );
  });

  it('refuses a value check on the wrong tag, which could otherwise never fail', () => {
    expect(
      refusal({ kind: 'head', meta: { name: 'description' }, href: { contains: 'x' } }),
    ).toMatch(/`href` belongs to a `link`/);
    expect(refusal({ kind: 'head', link: { rel: 'icon' }, content: { contains: 'x' } })).toMatch(
      /`content` belongs to a `meta`/,
    );
  });

  it('refuses a value check that says neither contains nor equals, or both', () => {
    expect(parses({ kind: 'head', link: { rel: 'icon' }, href: {} })).toBe(false);
    expect(
      parses({ kind: 'head', link: { rel: 'icon' }, href: { contains: 'a', equals: 'b' } }),
    ).toBe(false);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(parses({ kind: 'head', link: { rel: 'icon' }, selector: 'link[rel=icon]' })).toBe(false);
    expect(parses({ kind: 'head', link: { rel: 'icon', sizes: '32x32' } })).toBe(false);
  });
});

describe('where the head predicate sits in the vocabulary', () => {
  it('is introspectable, so the grammar reticle_tools prints lists it', () => {
    expect(Object.keys(predicateShapeFor(PredicateKind.HEAD) ?? {}).sort()).toEqual(
      ['absent', 'content', 'href', 'kind', 'link', 'meta'].sort(),
    );
  });

  it('reads the UI channel', () => {
    expect(channelsReadBy({ kind: PredicateKind.HEAD, link: { rel: 'icon' } })).toEqual([
      ChannelId.UI,
    ]);
  });

  it('grades as presence, so a head-only flow is not graded assertion-free', () => {
    expect(PRESENCE_GRADED.has(PredicateKind.HEAD)).toBe(true);
  });
});
