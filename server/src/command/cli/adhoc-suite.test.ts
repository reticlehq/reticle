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
import { runAdhocExplore, runAdhocSuite } from './adhoc-suite.js';
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

  /*
   * The daemon answers with the report as TEXT, not as `structuredContent`, and a suite report has
   * no `verified` key. Found by driving it: the headline printed "status: unverifiable" while the
   * JSON underneath said `"status":"fail"` with 74 failing flows, which is the same one-response-
   * two-answers defect the one-shot path already carries a comment about.
   */
  it('reads the status out of a TEXT result, not just structuredContent', async () => {
    const tool: ToolCaller = {
      call: () =>
        Promise.resolve({
          content: [{ text: JSON.stringify({ status: 'fail', total: 98, passed: 5 }) }],
        }),
      close: () => Promise.resolve(),
    };
    const result = await runAdhocSuite({ port: 4400, connect: () => Promise.resolve(tool) });
    expect(result.lines[0]).toBe('status: fail');
    expect(result.code).toBe(1);
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

  /*
   * The SDK's per-request default is 60s. A suite replays every saved flow, each driving a real
   * browser through a real journey, so a project with a few dozen takes minutes. Found by driving
   * it: the call timed out mid-run and reported "the suite could not be run" while the flows were
   * still running, which is a sentence about the transport wearing the shape of a verdict.
   */
  it('gives the call a suite-sized timeout, not a request-sized one', async () => {
    const seen: (number | undefined)[] = [];
    const tool: ToolCaller = {
      call: (_name, _args, timeoutMs) => {
        seen.push(timeoutMs);
        return Promise.resolve({ structuredContent: { status: 'pass' } });
      },
      close: () => Promise.resolve(),
    };
    await runAdhocSuite({ port: 4400, connect: () => Promise.resolve(tool) });
    expect(seen[0]).toBeGreaterThan(60_000);
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

/**
 * `reticle verify <url> --explore` after init — the first run init itself recommends — refused
 * because init's daemon owned the port. The same daemon runs the same explore, so ask it, then
 * replay what it recorded: the verdict is the suite's, exactly as on the path that owns its browser.
 */
describe('exploring through the running daemon', () => {
  const actionOf = (name: string, args: Record<string, unknown>): string | undefined =>
    ReticleTool.VERIFY === name
      ? (args['action'] as string | undefined)
      : (args['args'] as { action?: string } | undefined)?.action;

  const recording = (answers: Record<string, unknown> = {}) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const defaults: Record<string, unknown> = {
      acquire: { structuredContent: { sessionId: 'lease-9' } },
      explore: { structuredContent: { stopReason: 'done', savedFlows: ['counter'] } },
      flows: { structuredContent: { status: 'pass', summary: '1/1 passed' } },
    };
    const tool: ToolCaller = {
      call: (name, args) => {
        calls.push({ name, args });
        const action = actionOf(name, args) ?? '';
        return Promise.resolve(answers[action] ?? defaults[action] ?? {});
      },
      close: () => Promise.resolve(),
    };
    return { calls, tool, actions: () => calls.map((c) => actionOf(c.name, c.args)) };
  };

  const explore = (tool: ToolCaller, tabs: { url: string }[] = []) =>
    runAdhocExplore({
      port: 4400,
      url: 'http://localhost:5190/',
      persona: 'a visitor',
      connect: () => Promise.resolve(tool),
      sessions: () => Promise.resolve(tabs),
    });

  it('leases the url, explores it as the persona, replays the flows, then releases', async () => {
    const c = recording();
    const result = await explore(c.tool);
    expect(c.actions()).toEqual(['acquire', 'explore', 'flows', 'release']);
    expect(c.calls[1]?.args).toMatchObject({
      action: 'explore',
      persona: 'a visitor',
      sessionId: 'lease-9',
    });
    expect(c.calls[2]?.args['sessionId']).toBe('lease-9');
    expect(result.code).toBe(0);
  });

  it('drives the tab already open on that origin, and leases nothing', async () => {
    const c = recording();
    await explore(c.tool, [{ url: 'http://localhost:5190/' }]);
    expect(c.actions()).toEqual(['explore', 'flows']);
  });

  it('exits non-zero, and replays nothing, when the drive recorded nothing', async () => {
    const c = recording({
      explore: { structuredContent: { stopReason: 'done', savedFlows: [], note: 'nothing saved' } },
    });
    const result = await explore(c.tool, [{ url: 'http://localhost:5190/' }]);
    expect(result.code).toBe(1);
    expect(c.actions()).not.toContain('flows');
    expect(result.lines.join('\n')).toContain('nothing saved');
  });

  it("prints the daemon's refusal as a sentence, e.g. no model configured", async () => {
    const c = recording({
      explore: {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: 'No model configured' }) }],
      },
    });
    const result = await explore(c.tool, [{ url: 'http://localhost:5190/' }]);
    expect(result.code).toBe(1);
    expect(result.lines).toContain('No model configured');
  });

  it('fails the run when the replay fails', async () => {
    const c = recording({ flows: { structuredContent: { status: 'fail' } } });
    expect((await explore(c.tool)).code).toBe(1);
  });
});
