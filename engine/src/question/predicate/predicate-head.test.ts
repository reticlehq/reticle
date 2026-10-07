import { describe, expect, it } from 'vitest';
import {
  REDACTED_VALUE,
  ReticleCommand,
  type CommandResult,
  type HeadSnapshot,
  type ReticleEvent,
} from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';
import type { Predicate } from './predicate-eval.js';

/**
 * `{ kind: "head" }` (#1425): a `<link>` or `<meta>` in the live `<head>`, read through HEAD_READ.
 *
 * Every way of not knowing is `inconclusive`, never a failure: a page whose SDK predates the command,
 * an answer cut off before the tag could have appeared, a value redacted before it left the page.
 */
class HeadSession implements PredicateSession {
  readonly asked: string[] = [];
  constructor(private readonly answer: CommandResult) {}
  command(name: string): Promise<CommandResult> {
    this.asked.push(name);
    return Promise.resolve(this.answer);
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

const head = (snapshot: Partial<HeadSnapshot>): HeadSession =>
  new HeadSession({
    kind: 'command_result',
    id: 'x',
    ok: true,
    result: { links: [], metas: [], ...snapshot },
  });

const PAGE = head({
  links: [
    { rel: 'shortcut icon', href: '/icon.svg' },
    { rel: 'apple-touch-icon', href: '/touch.png' },
    { rel: 'canonical', href: 'https://app.test/plans' },
  ],
  metas: [
    { name: 'Description', content: 'Plan your week' },
    { property: 'og:image', content: 'https://app.test/card.png' },
  ],
});

const run = (session: PredicateSession, predicate: Predicate) =>
  evaluatePredicate(session, predicate);

describe('a link in the head', () => {
  it('matches rel as a token list, so "icon" finds "shortcut icon" but not "apple-touch-icon"', async () => {
    const result = await run(PAGE, {
      kind: 'head',
      link: { rel: 'icon' },
      href: { equals: '/icon.svg' },
    });
    expect(result.pass).toBe(true);
    expect(PAGE.asked).toContain(ReticleCommand.HEAD_READ);
  });

  it('checks the href by substring or whole value', async () => {
    expect(
      (await run(PAGE, { kind: 'head', link: { rel: 'canonical' }, href: { contains: '/plans' } }))
        .pass,
    ).toBe(true);
    expect(
      (await run(PAGE, { kind: 'head', link: { rel: 'canonical' }, href: { equals: '/plans' } }))
        .pass,
    ).toBe(false);
  });

  it('fails on a missing link, saying which links are there', async () => {
    const result = await run(PAGE, { kind: 'head', link: { rel: 'manifest' } });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
    expect(result.expected).toMatch(/<link rel="manifest">/);
    expect(result.observed).toMatch(/canonical/);
  });

  it('fails on the wrong href, saying what the href is', async () => {
    const result = await run(PAGE, {
      kind: 'head',
      link: { rel: 'icon' },
      href: { contains: 'favicon.ico' },
    });
    expect(result.pass).toBe(false);
    expect(result.observed).toMatch(/\/icon\.svg/);
  });
});

describe('a meta in the head', () => {
  it('matches name without regard to case, as HTML does', async () => {
    expect(
      (
        await run(PAGE, {
          kind: 'head',
          meta: { name: 'description' },
          content: { contains: 'week' },
        })
      ).pass,
    ).toBe(true);
  });

  it('matches Open Graph tags by property', async () => {
    expect(
      (
        await run(PAGE, {
          kind: 'head',
          meta: { property: 'og:image' },
          content: { contains: '.png' },
        })
      ).pass,
    ).toBe(true);
  });

  it('fails on content that does not hold, saying what it is', async () => {
    const result = await run(PAGE, {
      kind: 'head',
      meta: { name: 'description' },
      content: { equals: 'Plan your day' },
    });
    expect(result.pass).toBe(false);
    expect(result.observed).toMatch(/Plan your week/);
  });
});

describe('absent', () => {
  it('passes when no such tag is there, and fails when one is', async () => {
    expect((await run(PAGE, { kind: 'head', meta: { name: 'robots' }, absent: true })).pass).toBe(
      true,
    );
    expect((await run(PAGE, { kind: 'head', link: { rel: 'canonical' }, absent: true })).pass).toBe(
      false,
    );
  });
});

describe('what Reticle could not see is inconclusive, never a defect', () => {
  it('a page whose SDK does not answer HEAD_READ', async () => {
    const old = new HeadSession({
      kind: 'command_result',
      id: 'x',
      ok: false,
      error: 'not served',
    });
    const result = await run(old, { kind: 'head', link: { rel: 'icon' } });
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toMatch(/could not read its <head>/);
  });

  it('an answer that is not a head', async () => {
    const odd = new HeadSession({
      kind: 'command_result',
      id: 'x',
      ok: true,
      result: { links: 'nope' },
    });
    expect((await run(odd, { kind: 'head', link: { rel: 'icon' } })).inconclusive).toBeDefined();
  });

  it('a missing tag in an answer that was cut off', async () => {
    const cut = head({ links: [{ rel: 'canonical', href: '/' }], truncated: true });
    const missing = await run(cut, { kind: 'head', link: { rel: 'icon' } });
    expect(missing.inconclusive).toMatch(/cut off/);
    const mustBeAbsent = await run(cut, { kind: 'head', link: { rel: 'icon' }, absent: true });
    expect(mustBeAbsent.inconclusive).toMatch(/cut off/);
  });

  it('a found tag in an answer that was cut off still passes', async () => {
    const cut = head({ links: [{ rel: 'icon', href: '/icon.svg' }], truncated: true });
    expect((await run(cut, { kind: 'head', link: { rel: 'icon' } })).pass).toBe(true);
  });

  it('an exact check on a value that was only partly redacted', async () => {
    const partly = head({
      links: [
        { rel: 'preload', href: 'https://cdn.test/a.js?access_token=[REDACTED]', altered: true },
      ],
    });
    const exact = await run(partly, {
      kind: 'head',
      link: { rel: 'preload' },
      href: { equals: 'https://cdn.test/a.js?access_token=abc' },
    });
    expect(exact.pass).toBe(false);
    expect(exact.inconclusive).toMatch(/redacted or shortened/);
  });

  it('a substring check that the visible part of an altered value already proves still passes', async () => {
    const partly = head({
      links: [
        { rel: 'preload', href: 'https://cdn.test/a.js?access_token=[REDACTED]', altered: true },
      ],
    });
    const seen = await run(partly, {
      kind: 'head',
      link: { rel: 'preload' },
      href: { contains: 'cdn.test/a.js' },
    });
    expect(seen.pass).toBe(true);
  });

  it('a substring check past the end of a shortened value', async () => {
    const capped = head({
      metas: [{ name: 'description', content: 'x'.repeat(10), altered: true }],
    });
    const result = await run(capped, {
      kind: 'head',
      meta: { name: 'description' },
      content: { contains: 'tail' },
    });
    expect(result.inconclusive).toMatch(/redacted or shortened/);
  });

  it('a content check on a value that was redacted before it left the page', async () => {
    const redacted = head({
      metas: [{ name: 'csrf-token', content: REDACTED_VALUE, altered: true }],
    });
    const result = await run(redacted, {
      kind: 'head',
      meta: { name: 'csrf-token' },
      content: { equals: 'abc' },
    });
    expect(result.inconclusive).toMatch(/redacted or shortened/);
    expect((await run(redacted, { kind: 'head', meta: { name: 'csrf-token' } })).pass).toBe(true);
  });
});

describe('the grammar reticle_tools prints', () => {
  it('lists the head predicate and the tags it names', async () => {
    const { predicateGrammar } = await import('./predicate-schema.js');
    const head = predicateGrammar()['head'] ?? '';
    expect(head).toMatch(/link \{ rel \}/);
    expect(head).toMatch(/meta \{ name, property \}/);
    expect(head).toMatch(/href/);
    expect(head).toMatch(/content/);
  });
});
