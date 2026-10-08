/**
 * `reticle_act_and_wait` hands a net clause's `repeatable: true` to the duplicate rule (#1353).
 *
 * The same declaration `reticle_assert` passes, on the tool agents drive with. Two identical reads
 * of a declared read endpoint keep the verdict, and the same pair without the declaration is still
 * `duplicate-request`, so the two tools cannot drift apart on it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, REQUEST_SHAPE_FIELD, ReticleCommand } from '@reticlehq/core';
import { Bridge } from './bridge.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

interface Result {
  verdict: { pass: boolean };
  contradictions?: { kind: string }[];
}

let bridge: Bridge;
let deps: ToolDeps;
let browser: FakeBrowser;

beforeEach(async () => {
  bridge = new Bridge({ port: 0 });
  const port = await bridge.ready;
  deps = makeDeps(bridge);
  browser = new FakeBrowser(port, 'reads');
  await browser.open();
  await waitUntil(() => 1 === bridge.sessions.count());
});

afterEach(async () => {
  browser.close();
  await bridge.close();
});

/** Click, then the app posts the same query twice, as StrictMode's double effect does. */
async function clickThenReadTwice(net: Record<string, unknown>): Promise<Result> {
  const pending = callTool(deps, 'reticle_act_and_wait', {
    ref: 'e7',
    action: 'click',
    timeout_ms: 1000,
    until: { kind: 'net', method: 'POST', urlContains: '/graphql', ...net },
  }) as Promise<Result>;
  await waitUntil(() => browser.received.some((c) => ReticleCommand.ACT === c.name));
  for (const id of ['r1', 'r2']) {
    browser.emit(EventType.NET_REQUEST, {
      id,
      method: 'POST',
      url: '/graphql',
      status: 200,
      ok: true,
      [REQUEST_SHAPE_FIELD]: 'q1q2q3q4',
    });
  }
  browser.emit(EventType.DOM_ADDED, { path: 'main > ul' });
  return pending;
}

const kinds = (r: Result): string[] => (r.contradictions ?? []).map((c) => c.kind);

describe('act_and_wait over a read declared as one', () => {
  it('keeps two identical reads out of duplicate-request', async () => {
    const result = await clickThenReadTwice({ repeatable: true });
    expect(result.verdict.pass).toBe(true);
    expect(kinds(result)).not.toContain(ContradictionKind.DUPLICATE_REQUEST);
  });

  it('still reports duplicate-request without the declaration', async () => {
    expect(kinds(await clickThenReadTwice({}))).toContain(ContradictionKind.DUPLICATE_REQUEST);
  });
});
