import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { DriverLostError } from '@/features/compare/build-readings.js';
import { leasedPage, runCompareCommand } from './compare-command.js';
import type { ToolCaller } from '../daemon-link/daemon-client.js';

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

  it('presses a guarded control on a local build, and leaves the guard on a public one', async () => {
    // A submit named "Place order" or "Delete" is refused without confirmDangerous, so compare never
    // pressed the actions that matter most. On loopback or *.localhost the builds are disposable copies;
    // on any other host the guard stays, so a compare cannot delete real data.
    const local: unknown[] = [];
    await leasedPage(
      caller({ [ReticleTool.ACT]: text({ dispatched: true }) }, local),
      'http://127.0.0.1:4310/',
      's1',
    ).act('e1', 'click');
    expect((local[0] as { args: { args: Record<string, unknown> } }).args.args).toEqual({
      confirmDangerous: true,
    });
    const preview: unknown[] = [];
    await leasedPage(
      caller({ [ReticleTool.ACT]: text({ dispatched: true }) }, preview),
      'https://pr-12.app.example.com/',
      's1',
    ).act('e1', 'click');
    expect((preview[0] as { args: { args: Record<string, unknown> } }).args.args).toEqual({});
  });

  it('clicks a text probe by a text target, because a text line has no ref', async () => {
    const calls: unknown[] = [];
    await leasedPage(
      caller({ [ReticleTool.ACT]: text({ dispatched: true }) }, calls),
      'https://pr-12.app.example.com/',
      's1',
    ).act({ text: 'Details' }, 'click');
    expect((calls[0] as { args: Record<string, unknown> }).args).toEqual({
      target: { text: 'Details' },
      action: 'click',
      args: {},
      sessionId: 's1',
    });
  });

  it('opens a url parameter value against the build url, on the leased tab', async () => {
    const calls: unknown[] = [];
    const page = leasedPage(
      caller({ [ReticleTool.NAVIGATE]: text({ ok: true }) }, calls),
      'http://a/app/',
      's1',
    );
    expect(await page.goto?.('?view=grid')).toBe(true);
    expect((calls[0] as { args: Record<string, unknown> }).args).toMatchObject({
      url: 'http://a/app/?view=grid',
      sessionId: 's1',
    });
  });

  it('returns the cursor an action gives, for the effects of its sequence', async () => {
    const page = leasedPage(
      caller({ [ReticleTool.ACT]: text({ dispatched: true, since: 41 }) }),
      'http://a/',
      's1',
    );
    expect(await page.act('e1', 'click')).toEqual({ ok: true, since: 41 });
  });

  it('reads the network with bodies and the console from the cursor, with no window_ms', async () => {
    const calls: unknown[] = [];
    const page = leasedPage(
      caller(
        {
          [ReticleTool.NETWORK]: text({
            calls: [{ method: 'POST', url: 'http://a/api/x?k=1', status: 500, requestBody: '{}' }],
          }),
          [ReticleTool.CONSOLE]: text({ logs: [{ level: 'error', text: 'boom' }] }),
        },
        calls,
      ),
      'http://a/',
      's1',
    );
    expect(await page.effects(41)).toEqual(['net: POST /api/x?k= 500 {}', 'console error: boom']);
    expect(calls).toEqual([
      { tool: ReticleTool.NETWORK, args: { since: 41, bodies: true, limit: 50, sessionId: 's1' } },
      { tool: ReticleTool.CONSOLE, args: { since: 41, limit: 50, sessionId: 's1' } },
    ]);
  });

  it('writes a refused effects read as a line instead of dropping it', async () => {
    const page = leasedPage(
      caller({ [ReticleTool.NETWORK]: refused('window_ms is not allowed here') }),
      'http://a/',
      's1',
    );
    expect(await page.effects(1)).toContain(
      'effects failed: network: window_ms is not allowed here',
    );
  });

  it('counts a refused action as a step that could not be done', async () => {
    const page = leasedPage(
      caller({ [ReticleTool.ACT]: refused('ref e9 no longer resolves') }),
      'http://a/',
      's1',
    );
    expect((await page.act('e9', 'click')).ok).toBe(false);
  });

  it('throws a lost driver when the session is gone, so the run is invalid', async () => {
    const page = leasedPage(
      caller({ [ReticleTool.ACT]: refused("sessionId 's1' names no session") }),
      'http://a/',
      's1',
    );
    await expect(page.act('e1', 'click')).rejects.toBeInstanceOf(DriverLostError);
    await expect(page.act('e1', 'click')).rejects.toThrow(`${ReticleTool.ACT}: `);
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
