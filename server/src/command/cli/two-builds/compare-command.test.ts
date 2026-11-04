import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { DriverLostError } from '@/features/compare/build-readings.js';
import { leasedPage, runCompareCommand } from './compare-command.js';
import type { ToolCaller } from '../adhoc-verdict.js';

const text = (body: unknown): unknown => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
});
const refused = (message: string): unknown => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
});

/** A caller that answers each inner tool of `reticle_run` from `answers`. */
function caller(answers: Record<string, unknown>, calls: unknown[] = []): ToolCaller {
  return {
    call: (_name, args) => {
      calls.push(args);
      const tool = String((args as { tool?: unknown }).tool);
      return Promise.resolve(answers[tool] ?? text({}));
    },
    close: () => Promise.resolve(),
  };
}

describe('leasedPage', () => {
  it('reads the full tree with test ids, on the leased tab', async () => {
    const calls: unknown[] = [];
    const page = leasedPage(
      caller({ [ReticleTool.SNAPSHOT]: text({ tree: '- button "A" (ref=e1)' }) }, calls),
      'http://a/',
      's1',
    );
    expect(await page.read()).toBe('- button "A" (ref=e1)');
    expect(calls[0]).toEqual({
      tool: ReticleTool.SNAPSHOT,
      args: { mode: 'full', ids: true, sessionId: 's1' },
    });
  });

  it('follows the session id a navigation answers with', async () => {
    const calls: unknown[] = [];
    const page = leasedPage(
      caller({ [ReticleTool.NAVIGATE]: text({ ok: true, sessionId: 's2' }) }, calls),
      'http://a/',
      's1',
    );
    expect(await page.open()).toBe(true);
    await page.read();
    expect((calls[1] as { args: { sessionId: string } }).args.sessionId).toBe('s2');
  });

  it('counts a refused action as a step that could not be done', async () => {
    const page = leasedPage(
      caller({ [ReticleTool.ACT]: refused('ref e9 no longer resolves') }),
      'http://a/',
      's1',
    );
    expect(await page.act('e9', 'click')).toBe(false);
  });

  it('throws a lost driver when the session is gone, so the run is invalid', async () => {
    const page = leasedPage(
      caller({ [ReticleTool.ACT]: refused("sessionId 's1' names no session") }),
      'http://a/',
      's1',
    );
    await expect(page.act('e1', 'click')).rejects.toBeInstanceOf(DriverLostError);
  });
});

describe('runCompareCommand', () => {
  it('exits 2 and says why when the daemon cannot be reached', async () => {
    const out = await runCompareCommand({
      reference: 'http://a/',
      candidate: 'http://b/',
      json: false,
      port: 14400,
      connect: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(out.code).toBe(2);
    expect(out.lines[0]).toMatch(/^INVALID: could not reach the daemon on port 14400/);
  });

  it('prints one JSON object with --json', async () => {
    const out = await runCompareCommand({
      reference: 'http://a/',
      candidate: 'http://b/',
      json: true,
      port: 14400,
      connect: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0] ?? '')).toMatchObject({ verdict: 'invalid', exitCode: 2 });
  });
});
