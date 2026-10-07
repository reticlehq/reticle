/**
 * A verdict from the CLI, against the daemon that is already running.
 *
 * The dead end is not a defect in any tool — it is that the tools are not loaded in the client, and
 * there was no other supported way to reach a verdict from that state. The app is instrumented, the daemon is healthy, `doctor` shows a live connected page, and
 * the client (Codex, Cursor Cloud, Antigravity, Gemini CLI, or a Claude Code session whose MCP link
 * dropped) exposes no `reticle_*` tools, because they load only at client startup.
 *
 * `verify` then refused because the daemon owned the port — the normal state after a working
 * install. The other CLI verdict paths need saved flows, and a first-install project has none. And
 * our own guidance says never to stop the daemon, because that kills the agent's MCP link. So an
 * agent held a live, correctly-wired app and no path to a verdict short of a human restarting their
 * editor.
 */
import { describe, expect, it, vi } from 'vitest';
import { runAdhocVerdict, type ToolCaller } from './adhoc-verdict.js';
import { ReticleTool } from '@reticlehq/core';

/** A fake daemon: records what was asked, answers with the verdict it was given. */
function caller(verdict: unknown): { tool: ToolCaller; calls: { name: string; args: unknown }[] } {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    tool: {
      call: (name, args) => {
        calls.push({ name, args });
        return Promise.resolve({ structuredContent: verdict });
      },
      close: () => Promise.resolve(),
    },
  };
}

const run = (verdict: unknown, over = {}) => {
  const c = caller(verdict);
  return runAdhocVerdict({
    port: 4400,
    url: 'http://localhost:3000/',
    predicate: { kind: 'text', contains: 'Dashboard' },
    connect: () => Promise.resolve(c.tool),
    ...over,
  }).then((result) => ({ result, calls: c.calls }));
};

describe('a one-shot verdict against the running daemon', () => {
  it('navigates first, then asserts', async () => {
    const { calls } = await run({ verified: 'yes' });
    expect(calls.map((c) => c.name)).toEqual([ReticleTool.NAVIGATE, ReticleTool.ASSERT]);
  });

  it('skips the navigation when no url is given, asserting where the session already is', async () => {
    const { calls } = await run({ verified: 'yes' }, { url: undefined });
    expect(calls.map((c) => c.name)).toEqual([ReticleTool.ASSERT]);
  });

  it('passes the predicate through untouched', async () => {
    const { calls } = await run({ verified: 'yes' });
    expect(calls[1]?.args).toEqual({ predicate: { kind: 'text', contains: 'Dashboard' } });
  });
});

describe('what the exit code means', () => {
  it('exits 0 only when the predicate was PROVED', async () => {
    expect((await run({ verified: 'yes' })).result.code).toBe(0);
  });

  it.each([
    ['no — the assertion failed', 'no'],
    ['unknown — Reticle could not tell what happened', 'unknown'],
    ['no-fault — nothing was declared to prove', 'no-fault'],
  ])('exits non-zero on %s', async (_label, verified) => {
    const { result } = await run({ verified });
    expect(
      result.code,
      'a CI step that treats "could not tell" as success is the false green this exists to prevent',
    ).not.toBe(0);
  });

  it('reports the verdict and its reason to the reader', async () => {
    const { result } = await run({ verified: 'no', verifiedReason: 'assertion_failed' });
    expect(result.lines.join('\n')).toContain('verified: no');
    expect(result.lines.join('\n')).toContain('assertion_failed');
  });
});

describe('when the daemon cannot be reached', () => {
  it('says so and exits non-zero, rather than reporting a pass', async () => {
    const { result } = await run({}, { connect: () => Promise.reject(new Error('ECONNREFUSED')) });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('could not reach the daemon');
  });

  it('exits non-zero when the tool call itself throws', async () => {
    const tool: ToolCaller = {
      call: () => Promise.reject(new Error('tool exploded')),
      close: () => Promise.resolve(),
    };
    const { result } = await run({}, { connect: () => Promise.resolve(tool) });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('tool exploded');
  });

  it('closes the connection even when the call failed', async () => {
    const close = vi.fn(() => Promise.resolve());
    const tool: ToolCaller = { call: () => Promise.reject(new Error('x')), close };
    await run({}, { connect: () => Promise.resolve(tool) });
    expect(close, 'a leaked SSE connection holds an agent slot on the daemon').toHaveBeenCalled();
  });
});

/**
 * `--session-id` was parsed, printed in the help, and dropped on the floor.
 *
 * `parseVerifySuffix` reads it and `cli-verify.ts` never passed it on, so with more than one tab
 * connected the command failed with "multiple sessions connected — pass sessionId to target one":
 * advice whose own remedy could not be followed through this path. Measured on a machine with three
 * live sessions, where it also silently graded against the wrong one.
 */
describe('the session a one-shot verdict targets', () => {
  it('pins both the navigate and the assert to the session it was given', async () => {
    const { calls } = await run({ verified: 'yes' }, { sessionId: 's-42' });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect((call.args as { sessionId?: string }).sessionId).toBe('s-42');
    }
  });

  // Omitted means "whatever is connected", which is the single-session case and must stay untouched.
  it('sends no sessionId when none was asked for', async () => {
    const { calls } = await run({ verified: 'yes' });
    for (const call of calls) {
      expect((call.args as { sessionId?: string }).sessionId).toBeUndefined();
    }
  });
});

/**
 * The headline line disagreed with the body underneath it.
 *
 * `verdictOf` read `structuredContent` only. A daemon answering with the verdict as TEXT content
 * left it undefined, so the first line printed `verified: unknown` while the JSON below it said
 * `"verified":"no"` — two different answers to the one question, in one response. Observed against a
 * live daemon. The exit code was right either way, so this is legibility, not a false green.
 */
describe('a verdict carried as text, not structured content', () => {
  const textCaller = (payload: unknown): ToolCaller => ({
    call: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
    close: () => Promise.resolve(),
  });

  it('reads the verdict out of the text and agrees with itself', async () => {
    const result = await runAdhocVerdict({
      port: 4400,
      predicate: { kind: 'text', contains: 'x' },
      connect: () => Promise.resolve(textCaller({ verified: 'no', failureReason: 'it did not' })),
    });
    expect(result.lines[0]).toBe('verified: no');
    expect(result.code).toBe(1);
  });

  it('still exits 0 on a proved verdict that arrived as text', async () => {
    const result = await runAdhocVerdict({
      port: 4400,
      predicate: { kind: 'text', contains: 'x' },
      connect: () => Promise.resolve(textCaller({ verified: 'yes' })),
    });
    expect(result.lines[0]).toBe('verified: yes');
    expect(result.code).toBe(0);
  });

  // Text that is not a verdict at all must stay `unknown` rather than being read as one.
  it('leaves unparseable text as unknown', async () => {
    const result = await runAdhocVerdict({
      port: 4400,
      predicate: { kind: 'text', contains: 'x' },
      connect: () =>
        Promise.resolve({
          call: () => Promise.resolve({ content: [{ type: 'text', text: 'not json' }] }),
          close: () => Promise.resolve(),
        }),
    });
    expect(result.lines[0]).toBe('verified: unknown');
    expect(result.code).toBe(1);
  });
});

/**
 * `reticle verify <url> --expect …` straight after init, with the app running and no browser open.
 * It answered `verified: unknown` and a paragraph telling the reader to open a url — and the url it
 * named was another project's dev server on 5173, not the one they had just typed. The url was
 * already in the command; opening it is the whole request.
 */
describe('a url with no connected tab', () => {
  const actionOf = (args: Record<string, unknown>): string | undefined =>
    (args['args'] as { action?: string } | undefined)?.action;

  const leasing = (over: { acquire?: unknown } = {}) => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const tool: ToolCaller = {
      call: (name, args) => {
        calls.push({ name, args });
        if (ReticleTool.RUN === name && 'acquire' === actionOf(args)) {
          return Promise.resolve({ structuredContent: over.acquire ?? { sessionId: 'lease-1' } });
        }
        return Promise.resolve({ structuredContent: { verified: 'yes' } });
      },
      close: () => Promise.resolve(),
    };
    return { calls, tool };
  };

  it('leases a browser at that url, asserts on it, and releases it', async () => {
    const c = leasing();
    const result = await runAdhocVerdict({
      port: 4400,
      url: 'http://localhost:5190/',
      predicate: { kind: 'text', contains: 'count is 0' },
      connect: () => Promise.resolve(c.tool),
      sessions: () => Promise.resolve([]),
    });
    expect(result.code).toBe(0);
    expect(c.calls.map((x) => [x.name, actionOf(x.args)])).toEqual([
      [ReticleTool.RUN, 'acquire'],
      [ReticleTool.ASSERT, undefined],
      [ReticleTool.RUN, 'release'],
    ]);
    expect(c.calls[1]?.args['sessionId']).toBe('lease-1');
  });

  it('uses the tab already open on that origin instead of leasing, navigating it there', async () => {
    const c = leasing();
    await runAdhocVerdict({
      port: 4400,
      url: 'http://localhost:5190/cart',
      predicate: { kind: 'text', contains: 'x' },
      connect: () => Promise.resolve(c.tool),
      sessions: () => Promise.resolve([{ url: 'http://localhost:5190/' }]),
    });
    expect(c.calls.map((x) => x.name)).toEqual([ReticleTool.NAVIGATE, ReticleTool.ASSERT]);
  });

  // Navigating a tab to the url it already shows reloads it, and a reloaded Electron window is a
  // session that disconnects under the assert: `unknown — session disconnected`.
  it('does not reload a tab that is already on that url', async () => {
    const c = leasing();
    await runAdhocVerdict({
      port: 4400,
      url: 'http://localhost:5190',
      predicate: { kind: 'text', contains: 'x' },
      connect: () => Promise.resolve(c.tool),
      sessions: () => Promise.resolve([{ url: 'http://localhost:5190/' }]),
    });
    expect(c.calls.map((x) => x.name)).toEqual([ReticleTool.ASSERT]);
  });

  // `--session-id` skipped the same-document check entirely, so a pinned tab already on the url was
  // reloaded: page 2 of a list went back to page 1 before the assert read it (#1409).
  describe('with --session-id', () => {
    const pinned = (sessions: { url: string; sessionId?: string }[]) => {
      const c = leasing();
      return {
        c,
        run: (url: string) =>
          runAdhocVerdict({
            port: 4400,
            url,
            sessionId: 'tab-2',
            predicate: { kind: 'text', contains: 'page 2' },
            connect: () => Promise.resolve(c.tool),
            sessions: () => Promise.resolve(sessions),
          }),
      };
    };

    it('asserts a pinned tab already on the url without navigating it', async () => {
      const { c, run } = pinned([
        { sessionId: 'tab-1', url: 'http://localhost:5190/other' },
        { sessionId: 'tab-2', url: 'http://localhost:5190/list?page=2#top' },
      ]);
      await run('http://localhost:5190/list/?page=2');
      expect(c.calls.map((x) => x.name)).toEqual([ReticleTool.ASSERT]);
      expect(c.calls[0]?.args['sessionId']).toBe('tab-2');
    });

    it('still navigates a pinned tab on a different url', async () => {
      const { c, run } = pinned([{ sessionId: 'tab-2', url: 'http://localhost:5190/list?page=1' }]);
      await run('http://localhost:5190/list?page=2');
      expect(c.calls.map((x) => x.name)).toEqual([ReticleTool.NAVIGATE, ReticleTool.ASSERT]);
      expect(c.calls[0]?.args['sessionId']).toBe('tab-2');
    });

    it('does not borrow another tab that is on the url', async () => {
      const { c, run } = pinned([
        { sessionId: 'tab-1', url: 'http://localhost:5190/list?page=2' },
        { sessionId: 'tab-2', url: 'http://localhost:5190/' },
      ]);
      await run('http://localhost:5190/list?page=2');
      expect(c.calls.map((x) => x.name)).toEqual([ReticleTool.NAVIGATE, ReticleTool.ASSERT]);
    });

    it('navigates, as before, when the status read fails', async () => {
      const c = leasing();
      await runAdhocVerdict({
        port: 4400,
        url: 'http://localhost:5190/list',
        sessionId: 'tab-2',
        predicate: { kind: 'text', contains: 'x' },
        connect: () => Promise.resolve(c.tool),
        sessions: () => Promise.reject(new Error('status unreachable')),
      });
      expect(c.calls.map((x) => x.name)).toEqual([ReticleTool.NAVIGATE, ReticleTool.ASSERT]);
    });
  });

  it('reports why the lease failed instead of asserting against nothing', async () => {
    const c = leasing({ acquire: { error: 'Chromium is not installed for Playwright — run: x' } });
    const result = await runAdhocVerdict({
      port: 4400,
      url: 'http://localhost:5190/',
      predicate: { kind: 'text', contains: 'x' },
      connect: () => Promise.resolve(c.tool),
      sessions: () => Promise.resolve([]),
    });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toMatch(/Chromium is not installed/);
    expect(c.calls.map((x) => x.name)).not.toContain(ReticleTool.ASSERT);
  });
});
