/**
 * Advice about an unreachable tool must name a route that exists on THIS surface.
 *
 * The default surface ships no dispatch hatch: `advertisedTools` drops `reticle_run`, and
 * `reticle_tools` says so in as many words ("there is no hidden tail and no dispatch hatch to reach
 * one"). Three producers still named it anyway, because each answered "how is an unadvertised tool
 * reached" with a constant instead of with the live surface.
 *
 * Reproduced against a released daemon with one call (#978):
 *
 *     reticle_tools { names: ["reticle_coverage"] }
 *     -> "… Call reticle_verify { action: "coverage", ... } — through reticle_run
 *         if it is not advertised under this profile."
 *
 * `reticle_verify` IS advertised there, and `reticle_run` is neither advertised nor callable — so
 * one sentence was wrong twice, and the agent that follows it spends a turn to be told the tool it
 * was sent to does not exist. A wrong remedy costs more than no remedy: it is followed.
 *
 * Every set below is read off the REAL surface rather than hand-listed. A fixture that re-states the
 * decision under test is insensitive to it — the guard this file replaces was exactly that.
 */

import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { advertisedTools } from '@/surface/mcp/mcp.js';
import { ADVERTISE_ALL_ENV, TOOL_SURFACE } from './tool-surface.js';
import { tableForSurface } from './tools.js';
import { unadvertisedToolHelp } from './unadvertised-help.js';
import { liveCallText } from './live-call-text.js';
import { RECOVERY } from './error-recovery.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';

/**
 * Does this text route the reader through the dispatch hatch?
 *
 * A word boundary, not a substring: `reticle_run_export` is a real and entirely different tool, and
 * a naive `includes` reports every message that merely names it as a leak.
 */
const NAMES_THE_HATCH = /\breticle_run\b/;

/** The names a daemon on `surface` actually hands the agent — meta-tools included. */
const advertisedNames = (surface: (typeof TOOL_SURFACE)[keyof typeof TOOL_SURFACE]): Set<string> =>
  new Set(advertisedTools(surface).map((tool) => tool.name));

/** Every name the surface's own table holds, advertised or not. */
const knownNames = (surface: (typeof TOOL_SURFACE)[keyof typeof TOOL_SURFACE]): Set<string> =>
  new Set(tableForSurface(surface).map((tool) => tool.name));

/** The catalog tool as this surface advertises it, with the callable set it was built against. */
const discoveryTool = (
  surface: (typeof TOOL_SURFACE)[keyof typeof TOOL_SURFACE],
): ToolDef | undefined => advertisedTools(surface).find((tool) => tool.name === ReticleTool.TOOLS);

/** The discovery reply for one name, as the text an agent reads. */
const discoverError = async (
  surface: (typeof TOOL_SURFACE)[keyof typeof TOOL_SURFACE],
  name: string,
): Promise<string> => {
  const tool = discoveryTool(surface);
  expect(tool, 'every surface advertises the catalog').toBeDefined();
  const out = (await tool?.handler({} as ToolDeps, { names: [name] })) as {
    tools?: { name: string; error?: string }[];
  };
  return out.tools?.find((each) => name === each.name)?.error ?? '';
};

describe('the closed default surface never routes an agent through the hatch it dropped', () => {
  const advertised = advertisedNames(TOOL_SURFACE.MERGED);
  const known = knownNames(TOOL_SURFACE.MERGED);

  it('drops the dispatch hatch — the premise every assertion below rests on', () => {
    expect(advertised.has(ReticleTool.RUN)).toBe(false);
    expect(advertised.has(ReticleTool.TOOLS)).toBe(true);
  });

  it('answers a merged name in the catalog with the advertised call, not with the hatch', async () => {
    // The issue's own reproduction. `reticle_verify` is advertised here, so there is a call that
    // works and no reason to mention routing at all.
    const error = await discoverError(TOOL_SURFACE.MERGED, ReticleTool.COVERAGE);
    expect(error).not.toContain(ReticleTool.RUN);
    expect(error).toContain(ReticleTool.VERIFY);
    expect(error).toContain('coverage');
  });

  it('answers a merged name whose TARGET is also unadvertised with the switch, not the hatch', async () => {
    // `reticle_diff` moved into `reticle_baseline`, which this surface does not advertise either.
    // "Call reticle_baseline { action: "diff" }" is unreachable and "through reticle_run" is a lie,
    // so the only true answer is the env var that opens the wider surface.
    const error = await discoverError(TOOL_SURFACE.MERGED, ReticleTool.DIFF);
    expect(error).not.toContain(ReticleTool.RUN);
    expect(error).toContain(ADVERTISE_ALL_ENV);
  });

  it('answers a merged name CALLED by its old name with a route that exists', () => {
    // The other door into the same message: `unadvertisedToolHelp` runs on `tools/call`, where an
    // agent reaches a name it read in guidance written against an earlier release.
    const help = unadvertisedToolHelp(ReticleTool.DIFF, advertised, known) ?? '';
    expect(help).not.toContain(ReticleTool.RUN);
    expect(help).toContain(ADVERTISE_ALL_ENV);
  });

  it('keeps naming the advertised target when the merge landed somewhere reachable', () => {
    const help = unadvertisedToolHelp(ReticleTool.CRAWL, advertised, known) ?? '';
    expect(help).not.toContain(ReticleTool.RUN);
    expect(help).toContain(ReticleTool.VERIFY);
  });

  /**
   * The whole family at once, over every name the surface no longer answers.
   *
   * The three call sites were found one at a time and fixed one at a time twice before; a sweep is
   * what makes the next merge covered on the day it lands rather than the day somebody drives it.
   */
  it('names the hatch nowhere, for any name this surface has stopped answering', async () => {
    const gone = [...known, ...Object.values(ReticleTool)].filter(
      (name) => !advertised.has(name) && name !== ReticleTool.RUN,
    );
    expect(
      gone.length,
      'the sweep would be vacuous if the surface advertised everything',
    ).toBeGreaterThan(10);
    const leaks: string[] = [];
    for (const name of new Set(gone)) {
      const help = unadvertisedToolHelp(name, advertised, known) ?? '';
      if (NAMES_THE_HATCH.test(help)) leaks.push(`tools/call ${name}`);
      const error = await discoverError(TOOL_SURFACE.MERGED, name);
      if (NAMES_THE_HATCH.test(error)) leaks.push(`reticle_tools ${name}`);
    }
    expect(leaks, 'each of these hands the agent a call that answers "not found"').toEqual([]);
  });
});

/**
 * The hatch is real on the surfaces that carry it, and the advice there must keep saying so.
 *
 * Deriving the remedy from the live surface is only a fix if it still produces the `reticle_run`
 * route where `reticle_run` is the route. Removing the sentence everywhere would trade a wrong
 * remedy for a missing one on every surface a user opts into.
 */
describe('a surface that keeps the hatch is still told about it', () => {
  const advertised = advertisedNames(TOOL_SURFACE.DEFAULT);
  const known = knownNames(TOOL_SURFACE.DEFAULT);

  it('advertises the hatch — the premise for this block', () => {
    expect(advertised.has(ReticleTool.RUN)).toBe(true);
  });

  it('routes a merged name whose target is unadvertised through the hatch', () => {
    const help = unadvertisedToolHelp(ReticleTool.DIFF, advertised, known) ?? '';
    expect(help).toContain(ReticleTool.RUN);
    expect(help).toContain(ReticleTool.BASELINE);
  });

  it('routes a real-but-unadvertised tool through the hatch', () => {
    const help = unadvertisedToolHelp(ReticleTool.EXPLORE, advertised, known) ?? '';
    expect(help).toContain(ReticleTool.RUN);
    expect(help).toContain(ReticleTool.EXPLORE);
  });

  it('keeps the catalog honest about the hatch when discovery resolves a merged name', async () => {
    const error = await discoverError(TOOL_SURFACE.DEFAULT, ReticleTool.DIFF);
    expect(error).toContain(ReticleTool.BASELINE);
    expect(error).toContain(ReticleTool.RUN);
  });

  it('says nothing about routing for a tool the agent can already call', () => {
    expect(unadvertisedToolHelp(ReticleTool.ACT, advertised, known)).toBeUndefined();
  });
});

/**
 * The recoveries that were ALREADY honest, pinned so this change cannot quietly undo them.
 *
 * `error-recovery.ts` still writes `reticle_run { tool: "reticle_lease", … }` into three hints, and
 * that is not a defect: `liveCallText` rewrites it at the MCP boundary into the CLI route, which is
 * the one escape hatch that survives every surface. The producer is a constant on purpose — the next
 * such string is written by somebody who does not know this rule exists — so what has to hold is the
 * OUTPUT, and that is what these assert.
 */
describe('the recovery hints reach a closed surface with a route that works', () => {
  const advertised = advertisedNames(TOOL_SURFACE.MERGED);

  it('names the hatch in no hint at all', () => {
    const leaks = Object.entries(RECOVERY)
      .map(([key, hint]) => [key, liveCallText(hint, advertised)] as const)
      .filter(([, text]) => text.includes(ReticleTool.RUN))
      .map(([key]) => key);
    expect(leaks).toEqual([]);
  });

  it('still hands over the CLI route the lease hints were reaching for', () => {
    const throttled = liveCallText(RECOVERY.THROTTLED, advertised);
    expect(throttled).not.toContain(ReticleTool.LEASE);
    expect(throttled).toContain('reticle open');
  });

  it('leaves a hint naming only advertised tools exactly as written', () => {
    expect(liveCallText(RECOVERY.NOT_EDITABLE, advertised)).toBe(RECOVERY.NOT_EDITABLE);
  });
});
