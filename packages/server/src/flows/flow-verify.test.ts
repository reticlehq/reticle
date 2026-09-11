import { describe, expect, it } from 'vitest';
import { ReplayStatus } from '@reticlehq/core';
import { leasableAppUrl, leaseFailureReplay } from './flow-tools.js';
import type { ToolDeps } from '../tools/tools.js';
import type { Session, SessionManager } from '../session/session.js';
import { TOOLS } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';

/**
 * `reticle_flow_verify` is the tool a CI user runs first, and it had no tests at all — nothing
 * referenced it by name or enum. Its two decision helpers were module-private and entirely unexercised,
 * and they are exactly where a wrong answer is silent rather than loud:
 *
 *  - `leasableAppUrl` decides whether the PARALLEL path is available. Returning undefined does not fail
 *    anything; it quietly downgrades an explicit `parallel` request to a shared-tab sequential run, so
 *    flows inherit each other's leftover state. That is a correctness change disguised as a fallback.
 *  - `leaseFailureReplay` decides what a flow that never got a context reports. If it produced anything
 *    other than an error, a suite would count an un-run flow as fine — a false green in the one tool
 *    whose entire job is telling CI whether the app works.
 */

function depsWithSessionUrl(url: string | undefined): ToolDeps {
  const resolve = (): Session => {
    if (url === undefined) throw new Error('no connected session');
    return { url } as unknown as Session;
  };
  return { sessions: { resolve } as unknown as SessionManager } as unknown as ToolDeps;
}

describe('leasableAppUrl — gates the parallel path', () => {
  it('reduces a deep page URL to its ORIGIN, so every leased context starts from the same place', () => {
    // It used a drifting live-tab URL once; a lease then opened whatever route the human last visited.
    expect(leasableAppUrl(depsWithSessionUrl('http://localhost:3000/checkout?step=2'), 's1')).toBe(
      'http://localhost:3000',
    );
  });

  it('falls back to sequential when no session is connected, rather than throwing', () => {
    expect(leasableAppUrl(depsWithSessionUrl(undefined), 's1')).toBeUndefined();
  });

  it('falls back to sequential on an unparseable URL', () => {
    expect(leasableAppUrl(depsWithSessionUrl('not-a-url'), 's1')).toBeUndefined();
  });

  it('treats an empty URL as no URL — an empty origin would be a silently broken lease target', () => {
    expect(leasableAppUrl(depsWithSessionUrl(''), 's1')).toBeUndefined();
  });
});

describe('leaseFailureReplay — a flow that never ran is never a pass', () => {
  it('reports ERROR, not pass, when the leased context never came up', () => {
    const result = leaseFailureReplay('checkout', 'browser launch failed');
    expect(result.status).toBe(ReplayStatus.ERROR);
    expect(result.name).toBe('checkout');
  });

  it('carries the underlying reason so CI output is diagnosable', () => {
    expect(leaseFailureReplay('checkout', 'browser launch failed').error?.message).toContain(
      'browser launch failed',
    );
  });

  it('still reports ERROR when the cause is unknown — never a vacuous success', () => {
    const result = leaseFailureReplay('checkout', undefined);
    expect(result.status).toBe(ReplayStatus.ERROR);
    expect(result.error?.message).toContain('unknown error');
  });

  it('reports no steps, so a failed lease cannot look like a flow that did work', () => {
    expect(leaseFailureReplay('checkout', 'x').steps).toEqual([]);
  });
});

/**
 * The `action` argument arrives from the wire and was previously coerced with `asString(...) ?? ''`,
 * so an unknown or missing action became the empty string and travelled on — reaching the browser as a
 * command it could not perform, and surfacing as a generic failure instead of "that is not an action".
 * ActionType is a closed union that already existed; the boundary now narrows to it and says what the
 * valid values are, which is the difference between a diagnosable error and a confusing one.
 */
describe('act rejects an unknown action at the wire boundary', () => {
  const actTool = (): {
    handler: (deps: unknown, args: Record<string, unknown>) => Promise<unknown>;
  } => {
    const tool = TOOLS.find((t) => t.name === ReticleTool.ACT);
    if (tool === undefined) throw new Error('reticle_act missing from the surface');
    return tool as unknown as {
      handler: (d: unknown, a: Record<string, unknown>) => Promise<unknown>;
    };
  };

  it('names the offending value AND the legal ones, instead of failing generically', async () => {
    await expect(actTool().handler({}, { ref: 'e1', action: 'clcik' })).rejects.toThrow(
      /unknown action 'clcik'.*click/s,
    );
  });

  it('rejects a missing action rather than dispatching an empty one', async () => {
    await expect(actTool().handler({}, { ref: 'e1' })).rejects.toThrow(/unknown action/);
  });
});
