/**
 * Matrix drive: `reticle_verify { action: "flows", names: ["no-such-flow"] }` ran the typo as a
 * FAILED check, wrote a failed run to the dashboard, and told the agent to "check the element
 * state". A name no saved flow carries is a typo, not a regression: refused, nothing run.
 */
import { describe, expect, it } from 'vitest';
import { unknownFlowRefusal } from './suite-selection.js';

describe('verify flows with a name no saved flow carries', () => {
  it('is refused, naming the flows that do exist', () => {
    const refusal = unknownFlowRefusal(['no-such-flow'], ['sign-in', 'open-deployments']);
    expect(refusal?.message).toContain('"no-such-flow"');
    expect(refusal?.message).toContain('sign-in, open-deployments');
    expect(refusal?.message).toMatch(/nothing ran/i);
  });

  it('says there are none when no flow is saved', () => {
    expect(unknownFlowRefusal(['x'], [])?.message).toMatch(/no flows are saved/i);
  });

  it('caps the list it names, and says how many more', () => {
    const many = Array.from({ length: 30 }, (_, i) => `flow-${String(i)}`);
    const text = unknownFlowRefusal(['typo'], many)?.message ?? '';
    expect(text).toContain('flow-0');
    expect(text).not.toContain('flow-29');
    expect(text).toContain('and 20 more');
  });

  it('lets known names through', () => {
    expect(unknownFlowRefusal(['sign-in'], ['sign-in'])).toBeUndefined();
    expect(unknownFlowRefusal([], ['sign-in'])).toBeUndefined();
  });
});
