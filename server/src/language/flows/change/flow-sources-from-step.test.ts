import { describe, expect, it } from 'vitest';
import { AnchorKind, type FlowStep } from '@reticlehq/core';
import { flowSources } from './flow-sources.js';

/**
 * Which source files a saved flow covers — and why almost none of them covered any.
 *
 * `reticle_verify { action: "change" }` is the dev loop that matters: "I edited these files, replay
 * what covers them." Driven against this repo's own 39 saved flows it replayed FIFTY-TWO of them,
 * took 46 seconds, and answered `unknown` — because coverage was derived only from COMPONENT
 * anchors, and a recorder prefers a TESTID anchor whenever the element has one. So the flows most
 * likely to exist are exactly the ones that can never say what they cover, every one of them is
 * "unknown provenance", and the fail-safe re-runs the entire suite.
 *
 * The source pointer was never missing. The SDK resolves it from the element, `act_and_wait` already
 * returns it, and the verdict already uses it to say WHERE to look. It simply was not written onto
 * the step, so a flow forgot the one fact that makes a scoped replay possible.
 *
 * A step's own `source` is read here alongside the component anchor. Nothing is removed: a flow
 * recorded before this still derives what it always did.
 */
const step = (over: Partial<FlowStep>): FlowStep => ({
  tool: 'reticle_act',
  anchor: { kind: AnchorKind.ROLE, role: 'button' },
  ...over,
});

describe('flowSources', () => {
  it('still reads a COMPONENT anchor — the path that already worked', () => {
    const s = step({
      anchor: {
        kind: AnchorKind.COMPONENT,
        name: 'Login',
        source: { file: 'src/Login.tsx', line: 12 },
      },
    });
    expect(flowSources([s])).toEqual(['src/Login.tsx']);
  });

  it('reads a TESTID step that carries its own source — the case that was lost', () => {
    const s = step({
      anchor: { kind: AnchorKind.TESTID, value: 'login-submit' },
      source: { file: 'src/components/Login.tsx', line: 48 },
    });
    expect(flowSources([s])).toEqual(['src/components/Login.tsx']);
  });

  it('collects from nested sub-steps, so a batched journey still reports coverage', () => {
    const inner = step({
      anchor: { kind: AnchorKind.TESTID, value: 'pay' },
      source: { file: 'src/Checkout.tsx' },
    });
    const outer = step({ tool: 'reticle_act_sequence', steps: [inner] });
    expect(flowSources([outer])).toEqual(['src/Checkout.tsx']);
  });

  it('de-duplicates — a flow touching one file ten times covers one file', () => {
    const s = step({ source: { file: 'src/App.tsx' } });
    expect(flowSources([s, s, s])).toEqual(['src/App.tsx']);
  });

  it('still reports NOTHING for a flow with no source anywhere', () => {
    // Unknown provenance must stay unknown. Inventing coverage would make the fail-safe stop
    // re-running a flow that might well be affected, which is the one direction this must not fail.
    expect(flowSources([step({})])).toEqual([]);
  });
});
