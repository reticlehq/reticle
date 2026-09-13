import { describe, it, expect } from 'vitest';
import { FlowSchema, InvokeSchema, OVP_FLOW_GRAMMAR_VERSION } from '../index.js';

/**
 * Composition: a document that runs another document.
 *
 * A recorded journey is flat today, and the cost of that is not tidiness — it is ATTRIBUTION. One
 * long onboarding document that drifts at step 34 reports step 34, so a regression in signup and a
 * regression in payment-setup are the same message, and neither says whether the rest still holds.
 *
 * Composition earns its place only where it makes a failure NARROWER. Anything that adds nesting
 * without improving attribution has added cost and bought nothing.
 *
 * The state contract is the part that makes stitching honest rather than hopeful. A sub-flow that
 * assumes it starts signed-in passes alone and fails inside a composite for a reason neither
 * document mentions. So a document declares BOTH ends — and, exactly like `startState`, the
 * protocol does not look inside either: a protocol that parsed these would be a protocol with an
 * opinion about what a subject is, which is the opinion it exists not to have.
 */

const base = { version: OVP_FLOW_GRAMMAR_VERSION, claim: 'x', steps: [] };
const action = (id: string) => ({ id, actor: 'agent', capability: 'click', at: 1 });

describe('the state contract', () => {
  // Asserting `success` alone would pass on a schema that has never heard of these fields: zod is
  // non-strict, so an unknown key parses and is then STRIPPED. The contract is that the value
  // SURVIVES, because a realm on the other side has to read it.
  it('carries a realm-opaque `requires` and `ensures` through the parse', () => {
    const parsed = FlowSchema.parse({
      ...base,
      name: 'signup',
      requires: { signedIn: false, level: 4 },
      ensures: { signedIn: true },
    });
    expect(parsed.requires).toEqual({ signedIn: false, level: 4 });
    expect(parsed.ensures).toEqual({ signedIn: true });
  });

  it('does not look inside them — a string is as valid as an object', () => {
    expect(FlowSchema.parse({ ...base, name: 'a', requires: '/checkout' }).requires).toBe(
      '/checkout',
    );
    expect(FlowSchema.parse({ ...base, name: 'a', ensures: 42 }).ensures).toBe(42);
  });

  it('still accepts a document that declares neither — start from wherever the subject is', () => {
    expect(FlowSchema.safeParse({ ...base, name: 'a' }).success).toBe(true);
  });
});

describe('invoking another document', () => {
  it('accepts an invoke step beside ordinary actions', () => {
    const parsed = FlowSchema.safeParse({
      ...base,
      name: 'onboarding/full',
      steps: [
        action('a1'),
        { id: 's1', invoke: 'onboarding/signup', with: { plan: 'pro' }, at: 2 },
        action('a2'),
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('takes a PATH as a name, so a directory is a namespace', () => {
    expect(
      InvokeSchema.safeParse({ id: 'i', invoke: 'onboarding/signup/email', at: 1 }).success,
    ).toBe(true);
    // A flat name is still a name — every document written before composition existed has one.
    expect(InvokeSchema.safeParse({ id: 'i', invoke: 'checkout', at: 1 }).success).toBe(true);
  });

  it('refuses a name that is not addressable', () => {
    // Each of these resolves to somewhere other than where it reads, which is how a document ends
    // up invoking something nobody named. Refused at the grammar, not left to each realm.
    for (const bad of ['', '/leading', 'trailing/', 'double//segment', '../escape', 'a/./b']) {
      expect(
        InvokeSchema.safeParse({ id: 'i', invoke: bad, at: 1 }).success,
        `"${bad}" must not parse as a flow name`,
      ).toBe(false);
    }
  });
});
