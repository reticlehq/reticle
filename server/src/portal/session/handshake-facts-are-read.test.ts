import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../machine/repo-root.js';

/**
 * Every fact the page tells us at HELLO must decide something.
 *
 * This codebase produced the same defect twice in one week, the second time in the commit that
 * fixed the first.
 *
 * Round one: `channels`, `platform` and `commands` existed on the wire schema, documented, and
 * **nothing set them**. The rule that refuses a claim reading an unwatched channel therefore had
 * nothing to read. Fixed by making the SDK declare all three.
 *
 * Round two: only `channels` was ever READ. `platform` and `commands` were declared by the page
 * and consumed by nobody -- the identical shape, one layer along, introduced by the fix. It
 * survived three rounds of asking "are we following the protocol", because the question kept
 * being answered at the sending end.
 *
 * A declaration nobody reads is indistinguishable from no declaration, however carefully it is
 * populated, and it is worse than absence because it looks finished. So the question is not "is
 * the field declared" but **what decides differently because of it** -- and that is checkable.
 *
 * `platform` is not on this interface for exactly that reason: it is a correct protocol field and
 * this daemon has no decision that needs it, because the runtime already arrives on the health
 * event. It stays on the wire, where other implementations can use it, and off the session, where
 * it would be dead weight.
 */

const FACTS = join(REPO_ROOT, 'server/src/portal/session/facts/handshake-facts.ts');

/** The fields `HandshakeFacts` declares, read from the interface rather than a second list. */
function declaredFacts(): string[] {
  const body = readFileSync(FACTS, 'utf8');
  const iface = body.slice(body.indexOf('export interface HandshakeFacts'));
  return [...iface.matchAll(/^\s{2}(?:readonly )?([a-zA-Z]+)\??:/gm)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
}

/** Non-test source in the server package, where a read would have to happen. */
function sources(): string[] {
  return execFileSync('git', ['ls-files', 'src'], {
    cwd: join(REPO_ROOT, 'server'),
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
}

describe('a handshake fact is kept only if something reads it', () => {
  const facts = declaredFacts();

  it('finds the fields, so a passing run cannot mean it read an empty interface', () => {
    expect(facts.length).toBeGreaterThan(3);
  });

  it.each(facts)('%s is read somewhere', (fact) => {
    const readers = sources().filter((file) => {
      if (file.endsWith('handshake-facts.ts')) return false; // the declaration is not a read
      const text = readFileSync(join(REPO_ROOT, 'server', file), 'utf8');
      // An ASSIGNMENT is not a read. `session.x = parsed.x` is exactly the shape that produced
      // this defect twice: the value arrives, is stored, and is never consulted.
      return new RegExp(`\\.${fact}\\b(?!\\s*=[^=])`).test(text);
    });
    expect(
      readers,
      `Nothing reads \`${fact}\`. Either give it a decision to make, or take it off the session ` +
        'and leave it on the wire for implementations that need it. A stored fact nobody reads ' +
        'is worse than an absent one, because it looks finished.',
    ).not.toEqual([]);
  });
});
