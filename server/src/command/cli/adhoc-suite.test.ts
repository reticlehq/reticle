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
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReticleTool } from '@reticlehq/core';
import { runAdhocExplore, runAdhocSuite } from './adhoc-suite.js';
import type { ToolCaller } from './adhoc-verdict.js';
import { FLOW_TOOLS } from '@/language/flows/flow-tools.js';
import { createMcpServer } from '@/surface/mcp/mcp.js';
import { KEY_REFUSED_LINE } from '@/surface/tools/reticle-result.js';
import { TOOL_SURFACE } from '@/surface/tools/tool-surface.js';
import type { ToolDeps } from '@/surface/tools/tools.js';

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

  /*
   * Persona drive: an unlinked `reticle verify` printed pass and a runId, and nothing said the run
   * stayed on this computer. The daemon's result block says it in its last line; it was only inside
   * the JSON dump below the summary.
   */
  it('prints the result block, so an unlinked run says it was kept on this machine', async () => {
    const block = '**Reticle result: proved** · 2 of 2\n- Kept on this machine only: connect';
    const { result } = await run({
      status: 'pass',
      summary: 'all 2 flows pass',
      reticleResult: block,
    });
    expect(result.lines.slice(0, 3)).toEqual(['status: pass', 'all 2 flows pass', block]);
  });

  // Persona drive (CI, revoked key): the suite passed, the run never reached the platform, and
  // `reticle verify` exited 0 under a block that said "Saved".
  it('exits non-zero when the platform refused the key, whatever the suite said', async () => {
    const block = `**Reticle result: proved** · 2 of 2 checks held\n- ${KEY_REFUSED_LINE}`;
    const { result } = await run({ status: 'pass', reticleResult: block });
    expect(result.code).toBe(1);
  });

  // Group D persona drive: RETICLE_SECRET_* given to `reticle verify` was ignored when a daemon was
  // already running — the daemon's environment is not the command's. They travel with the call.
  it("passes the command's RETICLE_SECRET_* values with the call, for this call only", async () => {
    process.env['RETICLE_SECRET_PASSWORD'] = 'hunter2';
    try {
      const { calls } = await run({ status: 'pass' });
      expect(calls[0]?.args).toEqual({
        action: 'flows',
        secrets: { RETICLE_SECRET_PASSWORD: 'hunter2' },
      });
    } finally {
      delete process.env['RETICLE_SECRET_PASSWORD'];
    }
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

  // `reticle_verify` declares `labels`, not `select`. This test pinned `select`, so `reticle verify
  // <url> --select <label>` was refused as an unknown parameter on every run and graded nothing.
  it('narrows the suite when labels were named, under the name the tool declares', async () => {
    const { calls } = await run({ status: 'pass', total: 1 }, { select: ['smoke'] });
    expect(calls[0]?.args).toEqual({ action: 'flows', labels: ['smoke'] });
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

  /** `reticle verify <url>` with no open tab answered "no browser session connected". */
  it('opens the url for a saved suite when no tab is on it, and releases it after', async () => {
    const c = recording();
    const result = await runAdhocSuite({
      port: 4400,
      url: 'http://localhost:5190/',
      sessions: () => Promise.resolve([]),
      connect: () => Promise.resolve(c.tool),
    });
    expect(c.actions()).toEqual(['acquire', 'flows', 'release']);
    expect(c.calls[1]?.args['sessionId']).toBe('lease-9');
    expect(result.code).toBe(0);
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

  it('never passes a drive the platform cut off, and prints why', async () => {
    const credits = 'Your 10 free credits are used. Add a card to start your 14-day trial.';
    const c = recording({
      explore: {
        structuredContent: { stopReason: 'broken', savedFlows: ['half'], error: credits },
      },
    });
    const result = await explore(c.tool, [{ url: 'http://localhost:5190/' }]);
    expect(result.code).toBe(1);
    expect(c.actions()).not.toContain('flows');
    expect(result.lines.join('\n')).toContain(credits);
  });

  it('fails the run when the replay fails', async () => {
    const c = recording({ flows: { structuredContent: { status: 'fail' } } });
    expect((await explore(c.tool)).code).toBe(1);
  });
});

/**
 * The recorded-call test above checks the key we send, not whether `reticle_verify` accepts it.
 * A key the tool does not declare is refused by the real MCP server, so this one sends the call there.
 */
describe('--select against the real tool surface', () => {
  it('reaches the flows handler with the labels, instead of being refused', async () => {
    const flows = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
    if (flows === undefined) {
      throw new Error('flow_verify missing');
    }
    const handler = vi.spyOn(flows, 'handler').mockResolvedValue({ status: 'pass' });

    const tab = {
      health: () => ({ throttled: false, focused: true }),
      takeSessionLease: () => undefined,
      ageWarning: () => undefined,
    };
    const server = createMcpServer(
      { sessions: { resolve: () => tab } } as unknown as ToolDeps,
      TOOL_SURFACE.DEFAULT,
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(clientSide);
    const tool: ToolCaller = {
      call: (name, args) => client.callTool({ name, arguments: args }),
      close: () => client.close(),
    };

    try {
      const result = await runAdhocSuite({
        port: 4400,
        select: ['smoke'],
        connect: () => Promise.resolve(tool),
      });
      expect(result.lines[0], result.lines.join(' ')).toBe('status: pass');
      expect(result.code).toBe(0);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0]?.[1]).toMatchObject({ action: 'flows', labels: ['smoke'] });
    } finally {
      handler.mockRestore();
      await server.close();
    }
  });
});
