/**
 * Save a baseline, then diff against it — the round trip the tool's own description prescribes.
 *
 * `reticle_baseline` is a MERGED family, and merge-tools states the assumption it rests on out loud:
 * "siblings share field names/meanings by construction". This family does not. `save` takes `name`;
 * `diff` takes `baseline`. The merged schema is the union of both with every field made optional, so
 * `{ action: "diff", name: "qa-base" }` is a perfectly VALID call that silently looks up the
 * baseline called `'default'` and reports `no baseline named 'default'` — while `save`'s own
 * description says "Use the same name in reticle_baseline{action:"diff"} to compare".
 *
 * Measured over real MCP against the bench app: save `qa-b2` → ok, diff `name: 'qa-b2'` → "no
 * baseline named 'default'", diff `baseline: 'qa-b2'` → the real diff. An agent following the
 * documentation gets an error naming a baseline it never mentioned.
 *
 * The unknown-parameter guard cannot catch this: after the merge, `name` IS a parameter of
 * `reticle_baseline`. The merge is what turned a required field into a silent default.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Bridge } from '../bridge/bridge.js';
import type { ToolDeps } from './tools.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from '../bridge/bridge.test-harness.js';

describe('reticle_baseline save → diff round trip', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'demo');
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('diff finds the baseline that save wrote, under the key save used', async () => {
    await callTool(deps, 'reticle_baseline', { action: 'save', name: 'round-trip' });
    const listed = (await callTool(deps, 'reticle_baseline', { action: 'list' })) as {
      baselines: string[];
    };
    expect(listed.baselines).toContain('round-trip');

    // The call the save step's own description tells the agent to make.
    const diffed = (await callTool(deps, 'reticle_baseline', {
      action: 'diff',
      name: 'round-trip',
    })) as { baseline?: string; error?: string };
    expect(diffed.error).toBeUndefined();
    expect(diffed.baseline).toBe('round-trip');
  });

  it('still accepts the documented `baseline` key', async () => {
    await callTool(deps, 'reticle_baseline', { action: 'save', name: 'by-key' });
    const diffed = (await callTool(deps, 'reticle_baseline', {
      action: 'diff',
      baseline: 'by-key',
    })) as { baseline?: string; error?: string };
    expect(diffed.error).toBeUndefined();
    expect(diffed.baseline).toBe('by-key');
  });
});
