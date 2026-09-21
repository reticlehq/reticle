import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { buildDynamicTools } from './dynamic-tools.js';
import { filterTools, TOOL_SURFACE } from './tool-surface.js';
import type { ToolDeps } from './tools.js';
import { tableForSurface } from './tools.js';

/**
 * A name in `tool-names.ts` answered `unknown tool` on the surface a daemon actually serves.
 *
 * `reticle_reconcile` is the capability 3.1.0 leads with, and `reticle_lineage` is the one an open
 * issue is about. Neither is among the tools that surface advertises, and neither is in the list of
 * names that were merged or withdrawn, so discovery answered with the same string it uses for a
 * typo. An agent cannot tell "restart with the full surface" from "no such capability", and it
 * stops. `documented-names.test.ts` checks docs, not this.
 */
const NO_DEPS = {} as ToolDeps;

describe('every wire name is accounted for on the merged surface', () => {
  it('does not answer unknown tool for a name ReticleTool exports', async () => {
    const surface = TOOL_SURFACE.MERGED;
    const table = [...tableForSurface(surface)];
    const callable = new Set(filterTools(table, surface).map((tool) => tool.name));
    const discover = buildDynamicTools(table, { active: surface, source: 'test' }, callable).find(
      (tool) => tool.name === ReticleTool.TOOLS,
    );
    if (discover === undefined) throw new Error('reticle_tools was not built');
    const names = [...new Set(Object.values(ReticleTool))];
    const out = (await discover.handler(NO_DEPS, { names })) as {
      tools: { name: string; error?: string; description?: string }[];
    };
    const silent = out.tools
      .filter((row) => undefined === row.description && 'unknown tool' === row.error)
      .map((row) => row.name);
    expect(
      silent,
      'these names are in the wire contract and the merged surface answers as if they were ' +
        'never tools. Advertise the tool, redirect the name, or say the surface cannot call it.',
    ).toEqual([]);

    const reconcile = out.tools.find((row) => ReticleTool.RECONCILE === row.name);
    expect(reconcile?.error ?? reconcile?.description ?? '').not.toBe('unknown tool');
    expect(`${reconcile?.error ?? ''}${reconcile?.description ?? ''}`).toContain(
      ReticleTool.RECONCILE,
    );
    const lineage = out.tools.find((row) => ReticleTool.LINEAGE === row.name);
    expect(lineage?.error).not.toBe('unknown tool');
  });

  it('a name that is not a tool is still unknown', async () => {
    const surface = TOOL_SURFACE.MERGED;
    const table = [...tableForSurface(surface)];
    const callable = new Set(filterTools(table, surface).map((tool) => tool.name));
    const discover = buildDynamicTools(table, { active: surface, source: 'test' }, callable).find(
      (tool) => tool.name === ReticleTool.TOOLS,
    );
    if (discover === undefined) throw new Error('reticle_tools was not built');
    const out = (await discover.handler(NO_DEPS, { names: ['reticle_not_a_tool'] })) as {
      tools: { error?: string }[];
    };
    expect(out.tools[0]?.error).toBe('unknown tool');
  });
});
