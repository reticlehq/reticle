import { describe, expect, it } from 'vitest';
import { ReplayStatus, type FlowFile, type FlowReplayResult } from '@reticlehq/core';
import { buildSuiteVerdict } from './decision.js';

/**
 * The third coverage number, at suite level.
 *
 * `coverage` says how much of what the suite drove it proved. It is silent about the routes the
 * suite never opened — and a selection that replays two of eleven flows is exactly the shape where
 * "all 2 flows pass" is true and useless. Known routes come from every flow the project HAS, so the
 * gap is measurable without exploring anything new.
 */

function flow(name: string, startPath: string): FlowFile {
  return { name, startPath, steps: [{ tool: 'click', args: {} }] } as unknown as FlowFile;
}

function passed(name: string): FlowReplayResult {
  return { name, status: ReplayStatus.OK, steps: [{ step: 0, ok: true }] } as FlowReplayResult;
}

describe('routes the suite never opened', () => {
  it('names a known route no replayed flow started on', () => {
    const verdict = buildSuiteVerdict(
      [{ replay: passed('a'), flow: flow('a', '/orders') }],
      ['/orders', '/billing'],
    );
    expect(verdict.unreached).toEqual(['/billing']);
  });

  it('says so in the summary, where a reader will actually see it', () => {
    const verdict = buildSuiteVerdict(
      [{ replay: passed('a'), flow: flow('a', '/orders') }],
      ['/orders', '/billing'],
    );
    expect(verdict.summary).toContain('/billing');
  });

  it('omits the field when every known route was driven', () => {
    const verdict = buildSuiteVerdict(
      [{ replay: passed('a'), flow: flow('a', '/orders') }],
      ['/orders'],
    );
    expect(verdict.unreached).toBeUndefined();
    expect(verdict.summary).not.toContain('never opened');
  });

  it('omits the field when the caller knows of no routes, rather than reporting a clean sweep', () => {
    // Saying "0 routes unreached" from an empty ledger would read as proof of coverage.
    const verdict = buildSuiteVerdict([{ replay: passed('a'), flow: flow('a', '/orders') }]);
    expect(verdict.unreached).toBeUndefined();
  });
});
