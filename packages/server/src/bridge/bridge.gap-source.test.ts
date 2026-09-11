import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Bridge } from './bridge.js';
import type { ToolDeps } from '../tools/tools.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

/**
 * A gap has to survive the trip to the "am I done?" call with a pointer at the code.
 *
 * `reticle_verify { action: "coverage" }` reads the gap ledger LONG after the verdict that filled
 * it, and by then the `ref` the gap carries is very likely dead — the page re-rendered, the control
 * was replaced or removed. An agent told the app is unverifiable, with only a handle that no longer
 * resolves, has nowhere to go. `source` is the half that stays true: it is a fact about the code,
 * not a handle to a DOM node.
 *
 * Driven over the real tools rather than the pure function, because a field can be produced
 * correctly and still never reach the agent — the result passes through the ledger, the merged
 * `reticle_verify` dispatch and an output schema, and any of the three can drop it silently.
 */

interface GapEntry {
  kind: string;
  source?: string;
  ref?: string;
}
interface ActResult {
  instrumentationGaps?: GapEntry[];
}
interface CoverageResult {
  instrumentationGaps?: GapEntry[];
  untouched: { ref: string }[];
}

const NO_SIGNAL = 'no-signal-on-mutation';
const ACTED_FILE = 'src/checkout/PayButton.tsx';
const ACTED_LINE = 114;

describe('an instrumentation gap keeps its file:line after the ref goes stale', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'demo');
    // The app IS source-mapped — the build plugin is installed — and it moved the DOM without
    // saying so. That is the gap worth a pointer: Reticle knows where the control is written.
    browser.actSource = { file: ACTED_FILE, line: ACTED_LINE };
    browser.actMutatedWithin = 3;
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('reports the gap with a source on the verdict, then again on coverage', async () => {
    const acted = (await callTool(deps, 'reticle_act_and_wait', {
      ref: 'e7',
      action: 'click',
      timeout_ms: 200,
      until: { kind: 'route', pathname: '/never-happens' },
    })) as ActResult;

    const onVerdict = acted.instrumentationGaps?.find((gap) => NO_SIGNAL === gap.kind);
    expect(onVerdict, 'a silent mutation should be reported').toBeDefined();
    expect(onVerdict?.source).toBe(`${ACTED_FILE}:${String(ACTED_LINE)}`);

    // The page re-rendered: the ref the gap named is gone. This is the ordinary case by the time
    // coverage is read, not an edge one.
    browser.snapshotResult = {
      tree: '- button "Pay" (ref=e91)',
      status: { route: '/checkout' },
    };

    const coverage = (await callTool(deps, 'reticle_verify', {
      action: 'coverage',
    })) as CoverageResult;
    expect(coverage.untouched.map((c) => c.ref)).toContain('e91');

    const later = coverage.instrumentationGaps?.find((gap) => NO_SIGNAL === gap.kind);
    expect(later, 'the ledger should still hold the gap').toBeDefined();
    expect(later?.source).toBe(`${ACTED_FILE}:${String(ACTED_LINE)}`);
  });
});
