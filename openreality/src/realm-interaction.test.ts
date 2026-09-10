import { describe, expect, it } from 'vitest';
import { REALM_VERBS } from './realm-interaction.js';

/**
 * The four verbs are a description of code that exists, not a wish about code that might.
 *
 * That is the only thing keeping this file honest. A list of things a realm "should" do, with no
 * implementation behind any of them, is a design document pretending to be a type -- and the next
 * person adds a fifth verb nobody has written, and the one after that conforms to none of it.
 */

describe('the verbs a realm must answer', () => {
  it('names four, in the order a drive uses them', () => {
    expect(REALM_VERBS.map((v) => v.verb)).toEqual(['describe', 'act', 'watch', 'photograph']);
  });

  it('every one says where the web realm already does it', () => {
    // The rule that stops this becoming aspirational. A verb with no existing implementation is a
    // proposal, and a proposal does not belong in a contract other people are asked to meet.
    for (const verb of REALM_VERBS) {
      expect(verb.webImplementation.length, verb.verb).toBeGreaterThan(10);
      expect(verb.meaning.length, verb.verb).toBeGreaterThan(40);
    }
  });

  it('keeps looking and photographing apart', () => {
    // Folding them together is the obvious simplification and it is wrong: a tab is photographed
    // through the debugging protocol, a desktop window has no such endpoint, and photographing a
    // screen region instead captures whatever is in front of it.
    const verbs = REALM_VERBS.map((v) => v.verb);
    expect(verbs).toContain('describe');
    expect(verbs).toContain('photograph');
  });

  it('promises nothing about verdicts', () => {
    // A realm reports what it did and what it saw. Whether the declared consequence held is decided
    // elsewhere, from a channel other than the one that acted. A realm that could return a verdict
    // would be a verdict supplied by the thing being verified.
    const text = REALM_VERBS.map((v) => `${v.verb} ${v.meaning}`).join(' ');
    expect(text).not.toMatch(/\bverified\b|\bpassed\b|\bverdict:/);
  });
});
