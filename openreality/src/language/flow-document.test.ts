import { describe, it, expect } from 'vitest';
import { FlowSchema, OVP_FLOW_GRAMMAR_VERSION } from '../index.js';

/**
 * The OVP Flow Document: the grammar, named and versioned.
 *
 * A recording is a document in a language, and the point of publishing the grammar is that a tool
 * which imports none of this package's TypeScript can still write one — the schema ships as JSON
 * beside the code, generated from the same zod the reference implementation validates against, so a
 * schema that disagrees with the code is not a thing that can exist.
 *
 * `startState` is the field that makes the document realm-neutral. It was a web route — a `startPath`
 * — which quietly assumed every subject has URLs. A level in a game, a home position on a rig and a
 * signed-in container on a phone are all the same idea and none of them is a path, so the document
 * carries an opaque value the REALM interprets and validates. The protocol does not look inside it.
 */
describe('the OVP Flow Document', () => {
  it('is versioned, so a document can say which grammar it was written against', () => {
    expect(OVP_FLOW_GRAMMAR_VERSION).toBeGreaterThan(0);
  });

  it('accepts a realm-interpreted startState — not a web path', () => {
    const parsed = FlowSchema.safeParse({
      name: 'checkout',
      version: OVP_FLOW_GRAMMAR_VERSION,
      claim: 'a discount reduces the total',
      steps: [],
      startState: { level: 4, seed: 'abc' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a document with no startState — starting from wherever the subject is', () => {
    const parsed = FlowSchema.safeParse({
      name: 'checkout',
      version: OVP_FLOW_GRAMMAR_VERSION,
      claim: 'x',
      steps: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('does not look inside startState — a string route is as valid as an object', () => {
    const parsed = FlowSchema.safeParse({
      name: 'checkout',
      version: OVP_FLOW_GRAMMAR_VERSION,
      claim: 'x',
      steps: [],
      startState: '/checkout',
    });
    expect(parsed.success).toBe(true);
  });
});
