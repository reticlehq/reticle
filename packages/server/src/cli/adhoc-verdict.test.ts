/**
 * A verdict from the CLI, against the daemon that is already running.
 *
 * The largest single cluster in the field feedback was not a defect in any tool — it was that the
 * tools were not loaded in the client, and there was no supported way to reach a verdict from that
 * state. The app is instrumented, the daemon is healthy, `doctor` shows a live connected page, and
 * the client (Codex, Cursor Cloud, Antigravity, Gemini CLI, or a Claude Code session whose MCP link
 * dropped) exposes no `reticle_*` tools, because they load only at client startup.
 *
 * `verify` then refused because the daemon owned the port — the normal state after a working
 * install. The other CLI verdict paths need saved flows, and a first-install project has none. And
 * our own guidance says never to stop the daemon, because that kills the agent's MCP link. So an
 * agent held a live, correctly-wired app and no path to a verdict short of a human restarting their
 * editor; several reporters fell back to another tool and said so.
 */
import { describe, expect, it, vi } from 'vitest';
import { runAdhocVerdict, type ToolCaller } from './adhoc-verdict.js';
import { ReticleTool } from '../tools/tool-names.js';

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
