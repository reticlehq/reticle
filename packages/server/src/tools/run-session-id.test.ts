import { describe, expect, it } from 'vitest';
import { buildDynamicTools } from './dynamic-tools.js';
import { ReticleTool } from './tool-names.js';
import { TOOL_SURFACE } from './tool-surface.js';
import { z } from 'zod';
import type { ToolDef, ToolDeps } from './tools.js';

/**
 * `reticle_run` must be AIMABLE. It is the only way to reach an unadvertised tool, so on a machine
 * running several projects it has to be able to say which session it means.
 *
 * Reported from a real drive across 6 of 6 apps: it accepted `sessionId`, dropped it, resolved by the
 * daemon's cwd project, and then failed with "no browser session for project X" while NAMING the live
 * session that had just been asked for. It was then made to REFUSE the key, which is more honest but
 * still leaves the escape hatch un-aimable — the caller has to know to nest it.
 *
 * `sessionId` is universal across this surface: it is the shape an agent uses on every other tool.
 * Accepting it here and forwarding it to the target is the answer. An explicit `args.sessionId` still
 * wins, because that is the more specific instruction.
 */
describe('reticle_run can be aimed at a session', () => {
  const seen: Record<string, unknown>[] = [];
  const target: ToolDef = {
    name: ReticleTool.SNAPSHOT,
    description: 'stand-in',
    inputSchema: { sessionId: z.string().optional() },
    handler: (_deps, args) => {
      seen.push(args);
      return Promise.resolve({ ok: true });
    },
  };
  const run = buildDynamicTools([target], { active: TOOL_SURFACE.DEFAULT, source: 'test' }).find(
    (t) => ReticleTool.RUN === t.name,
  );
  const deps = {} as ToolDeps;

  it('forwards a top-level sessionId to the tool it invokes', async () => {
    seen.length = 0;
    await run?.handler(deps, { tool: ReticleTool.SNAPSHOT, args: {}, sessionId: 's-live' });
    expect(seen[0]?.['sessionId'], 'the target must receive the session it was aimed at').toBe(
      's-live',
    );
  });

  it('does not need args at all', async () => {
    seen.length = 0;
    await run?.handler(deps, { tool: ReticleTool.SNAPSHOT, sessionId: 's-live' });
    expect(seen[0]?.['sessionId']).toBe('s-live');
  });

  it('an explicit args.sessionId wins — the more specific instruction', async () => {
    seen.length = 0;
    await run?.handler(deps, {
      tool: ReticleTool.SNAPSHOT,
      args: { sessionId: 's-inner' },
      sessionId: 's-outer',
    });
    expect(seen[0]?.['sessionId']).toBe('s-inner');
  });

  it('does NOT inject a session into a tool that does not take one', async () => {
    // Injecting it would trip that tool's own unknown-key check and refuse a call the caller got
    // right — turning a convenience into a new failure.
    const sessionless: ToolDef = {
      name: ReticleTool.TOOLS,
      description: 'stand-in without a session',
      inputSchema: {},
      handler: (_deps, a) => {
        seen.push(a);
        return Promise.resolve({ ok: true });
      },
    };
    const runner = buildDynamicTools([sessionless], {
      active: TOOL_SURFACE.DEFAULT,
      source: 'test',
    }).find((t) => ReticleTool.RUN === t.name);
    seen.length = 0;
    const out = (await runner?.handler(deps, {
      tool: ReticleTool.TOOLS,
      sessionId: 's-live',
    })) as { error?: string };
    expect(out.error, 'a sessionless tool must not be refused for our injection').toBeUndefined();
  });

  it('still refuses a genuinely unknown top-level key', async () => {
    const out = (await run?.handler(deps, {
      tool: ReticleTool.SNAPSHOT,
      args: {},
      nonsense: 1,
    })) as { error?: string };
    expect(out.error).toMatch(/nonsense/);
  });
});
