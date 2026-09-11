import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from './tools.js';
import { CORE_TOOL_NAMES, TOOL_SURFACE } from './tool-surface.js';
import { advertisedConfig, advertisedTools } from '../mcp/mcp.js';
import { ReticleTool } from './tool-names.js';

/**
 * Examples are the fix for the one failure an agent cannot recover from on its own.
 *
 * A tool schema names the FIELDS; it does not say how they compose, and under the lean profiles only
 * the first sentence of the description survives. So an agent reads "execute one action against a
 * ref" and guesses `{ action: 'click', testid: 'x' }`. That guess is rejected inside the MCP SDK's
 * validation — before any of this package's error handling runs — so the reply is a raw zod dump
 * naming no field and showing no correct shape. The agent guesses again.
 *
 * Which makes a WRONG example strictly worse than none: it would teach the mistake with authority.
 * So each one is parsed against its own inputSchema here.
 */
describe('every advertised example is a call that would actually succeed', () => {
  const withExamples = TOOLS.filter((tool) => tool.example !== undefined);

  it('has examples to check', () => {
    expect(withExamples.length).toBeGreaterThan(0);
  });

  it.each(withExamples.map((tool) => [tool.name, tool] as const))(
    '%s: its example validates against its own inputSchema',
    (_name, tool) => {
      const parsed = z.object(tool.inputSchema).partial().safeParse(tool.example);
      expect(parsed.success ? null : parsed.error.issues).toBeNull();
    },
  );

  /**
   * Only mentioning fields the tool actually declares. A stray key parses fine (zod objects are not
   * strict here) while teaching the agent a field that does nothing — a silent lie with a green test.
   */
  it.each(withExamples.map((tool) => [tool.name, tool] as const))(
    '%s: its example uses only declared fields',
    (_name, tool) => {
      const declared = Object.keys(tool.inputSchema);
      for (const key of Object.keys(tool.example ?? {})) {
        expect(declared, `${key} is not a field of this tool`).toContain(key);
      }
    },
  );
});

/**
 * The core set is what a lean profile advertises, so it is where a guess is most likely and most
 * expensive — the description is trimmed hardest exactly there.
 */
describe('the core surface leaves nothing to guess', () => {
  const needExamples = TOOLS.filter(
    (tool) => CORE_TOOL_NAMES.has(tool.name) && Object.keys(tool.inputSchema).length > 1,
  );

  // Its own it(), because an empty `it.each` registers ZERO tests and reports the file
  // green with no warning — there is nothing to hang an assertion on. The sibling group
  // above already has this control; this one was missed.
  it('has a core surface to check', () => {
    expect(needExamples.length).toBeGreaterThan(0);
  });

  it.each(needExamples.map((tool) => [tool.name, tool] as const))(
    '%s carries an example call',
    (_name, tool) => {
      expect(tool.example).toBeDefined();
    },
  );
});

/**
 * A capability an agent cannot find is a capability that does not exist.
 *
 * Four separate times this surface turned out to already HAVE the cheap or high-signal option and
 * simply never say so where a lean profile could see it: `snapshot { diff }`, `state { depth }`,
 * `query { count_only }`, and the bug-catching predicate fields. Each was documented in prose that
 * the first-sentence trim discards, so the full profile knew and the DEFAULT profile did not.
 *
 * These pin the ones that pay for themselves many times over, against the advertised text rather
 * than the raw definition — the trim is exactly what used to hide them.
 */
describe('cost-saving and bug-catching options are discoverable in the DEFAULT profile', () => {
  const advertised = advertisedTools(TOOL_SURFACE.DEFAULT);
  const shown = (name: string): string => {
    const tool = advertised.find((t) => t.name === name);
    if (tool === undefined) return '';
    const config = advertisedConfig(tool, advertised, TOOL_SURFACE.DEFAULT);
    return `${config.description} ${JSON.stringify(tool.example ?? {})}`;
  };

  it.each([
    // [tool, the option, why it must be visible]
    [ReticleTool.QUERY, 'count_only', 'a count instead of every descriptor — ~30x smaller'],
    [ReticleTool.SNAPSHOT, 'diff', 'only what changed since the last look'],
    [ReticleTool.SNAPSHOT, 'interactive', 'controls only — ~3x smaller'],
    [ReticleTool.STATE, 'depth', 'the store SHAPE instead of every value — ~47x smaller'],
  ])('%s advertises `%s` (%s)', (tool, option, _why) => {
    expect(shown(tool)).toContain(option);
  });

  /** The checks that catch a bug rather than confirm an expectation. Worth their bytes. */
  it.each([
    ['net.count', 'a double-submit / retry storm'],
    ['console.absent', 'an action that worked while logging a caught error'],
    ['absent', 'something that should have disappeared and did not'],
  ])('the predicate grammar advertises %s (%s)', (option, _why) => {
    const predicateText = advertised
      .flatMap((tool) =>
        Object.entries(advertisedConfig(tool, advertised, TOOL_SURFACE.DEFAULT).inputSchema)
          .filter(([key]) => 'predicate' === key || 'until' === key)
          .map(([, schema]) => schema.description ?? ''),
      )
      .join(' ');
    expect(predicateText).toContain(option);
  });
});

/**
 * The sessionId guidance has to tell the agent to OMIT it.
 *
 * It used to read "omit when only ONE browser session is open", which is not how resolution works —
 * the manager scopes to the project, prefers the active non-throttled tab, and refuses rather than
 * guesses when genuinely ambiguous. Verified live: with three sessions connected (an app plus two
 * pool leases) omitting sessionId resolves correctly. But the wording said otherwise, so the agent
 * listed and filtered sessions by hand before every call — roughly ten times in one session. A
 * sentence that makes a working default look unsafe costs more than a missing feature.
 */
describe('session resolution is advertised as the default, not the exception', () => {
  const advertised = advertisedTools(TOOL_SURFACE.DEFAULT);
  const sessionParam = (name: string): string => {
    const tool = advertised.find((t) => t.name === name);
    if (tool === undefined) return '';
    const shape = advertisedConfig(tool, advertised, TOOL_SURFACE.DEFAULT).inputSchema;
    return shape['sessionId']?.description ?? '';
  };

  it('tells the agent to omit it', () => {
    expect(sessionParam(ReticleTool.SNAPSHOT).toLowerCase()).toContain('omit');
  });

  it('never re-introduces the "only one session" condition that caused the hand-filtering', () => {
    for (const tool of advertised) {
      const text = sessionParam(tool.name);
      if ('' === text) continue;
      expect(text, `${tool.name} must not condition omission on a single session`).not.toMatch(
        /omit when only one/i,
      );
    }
  });
});
