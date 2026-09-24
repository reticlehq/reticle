/**
 * The saved-flow suite, against the daemon that is already running.
 *
 * `--expect` removed the dead end for a ONE-SHOT verdict and left the other half of it standing:
 * a project WITH saved flows still could not run them, because `verify` refuses when the daemon
 * owns the port and the normal state after a working install is that the daemon owns the port. The
 * advice was to stop the daemon, which kills the agent's MCP link, and the whole point of a saved
 * suite is that it can be run again without one.
 *
 * Same trick as `runAdhocVerdict` and deliberately no new surface: ask the running daemon the
 * question an agent would ask it, over the transport it already serves.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { runAdhocSuite } from './adhoc-suite.js';
import type { ToolCaller } from './adhoc-verdict.js';

function caller(answer: unknown): { tool: ToolCaller; calls: { name: string; args: unknown }[] } {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    tool: {
      call: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve({ structuredContent: answer });
      },
      close: () => Promise.resolve(),
    },
  };
}

const run = (
  answer: unknown,
  over = {},
): Promise<{
  result: { code: number; lines: string[] };
  calls: { name: string; args: unknown }[];
}> => {
  const c = caller(answer);
  return runAdhocSuite({
    port: 4400,
    connect: () => Promise.resolve(c.tool),
    ...over,
  }).then((result) => ({ result, calls: c.calls }));
};

describe('a saved-flow suite against the running daemon', () => {
  it('runs the flows and exits 0 on a pass', async () => {
    const { result, calls } = await run({ status: 'pass', total: 3, passed: 3 });
    expect(calls.map((c) => c.name)).toEqual([ReticleTool.VERIFY]);
    expect(calls[0]?.args).toEqual({ action: 'flows' });
    expect(result.code).toBe(0);
  });

  it('exits non-zero on a failing suite', async () => {
    const { result } = await run({ status: 'fail', total: 3, passed: 2 });
    expect(result.code).toBe(1);
  });

  /*
   * `unverifiable` is not a pass and must never exit 0. It is what an empty suite reports, and a CI
   * step that reads "nothing was checked" as success is the false green this product exists to
   * prevent — the same rule the one-shot path holds for `unknown`.
   */
  it('exits non-zero when nothing was checked', async () => {
    const { result } = await run({ status: 'unverifiable', total: 0 });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('unverifiable');
  });

  it('narrows the suite when labels were named', async () => {
    const { calls } = await run({ status: 'pass', total: 1 }, { select: ['smoke'] });
    expect(calls[0]?.args).toEqual({ action: 'flows', select: ['smoke'] });
  });

  it('pins a tab when one was named, so a second open page is not graded instead', async () => {
    const { calls } = await run({ status: 'pass', total: 1 }, { sessionId: 's1' });
    expect(calls[0]?.args).toEqual({ action: 'flows', sessionId: 's1' });
  });

  it('reports a refusal as the tool worded it, not as an envelope', async () => {
    const tool: ToolCaller = {
      call: () =>
        Promise.resolve({ isError: true, content: [{ text: '{"error":"no session connected"}' }] }),
      close: () => Promise.resolve(),
    };
    const result = await runAdhocSuite({ port: 4400, connect: () => Promise.resolve(tool) });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('no session connected');
  });

  it('says so when the daemon cannot be reached at all', async () => {
    const result = await runAdhocSuite({
      port: 4400,
      connect: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('ECONNREFUSED');
  });
});
