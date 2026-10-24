import { describe, expect, it } from 'vitest';
import { SHARED_PARAM_SHORT, SHARED_PARAM_GUIDANCE, isSharedParam } from './shared-params.js';
import { advertisedConfig, advertisedTools } from './mcp.js';
import { resolveToolSurface } from '@/surface/tools/tool-surface.js';

describe('shared parameter vocabulary', () => {
  it('every short form is shorter than the guidance it points at', () => {
    for (const [name, short] of Object.entries(SHARED_PARAM_SHORT)) {
      expect(short.length, name).toBeLessThan(SHARED_PARAM_GUIDANCE.length);
      expect(short.length, `${name} short form should be terse`).toBeLessThan(90);
    }
  });

  /**
   * The point of the move is that the text still reaches the model, on a cheaper channel. If a
   * parameter is trimmed in the schema and NOT restated in instructions, this is not a saving — it
   * is a deletion, and the guidance is simply gone.
   */
  it('every trimmed parameter is restated in the instructions block', () => {
    for (const name of Object.keys(SHARED_PARAM_SHORT)) {
      expect(SHARED_PARAM_GUIDANCE, `${name} must be documented where it moved to`).toContain(name);
    }
  });

  /**
   * A client that drops `instructions` must still get something usable, so the short form has to
   * name the parameter's purpose rather than only point elsewhere.
   */
  it('each short form still says what the parameter IS, not only where to read about it', () => {
    expect(SHARED_PARAM_SHORT['sessionId']).toMatch(/tab/i);
    expect(SHARED_PARAM_SHORT['since']).toMatch(/cursor/i);
    expect(SHARED_PARAM_SHORT['limit']).toMatch(/cap/i);
  });

  it('recognises exactly the parameters it documents', () => {
    expect(isSharedParam('sessionId')).toBe(true);
    expect(isSharedParam('ref'), 'ref differs per tool and is not shared boilerplate').toBe(false);
  });
});

/**
 * What the default surface sends for each argument, after the lean rewrite.
 *
 * `since` on `reticle_observe` and `reticle_assert` is a number, but the shared text called it "a
 * cursor, or a git ref", so an agent could send a branch name and get a type error. Seven arguments,
 * among them the `runId` that the instructions tell an agent to poll, went out with no text at all.
 */
describe('the advertised arguments', () => {
  const surface = resolveToolSurface();
  const advertised = advertisedTools(surface);
  const params = advertised.flatMap((tool) =>
    Object.entries(advertisedConfig(tool, advertised, surface).inputSchema).map(
      ([name, schema]) => ({ at: `${tool.name}.${name}`, name, schema }),
    ),
  );

  it('every argument says what it is', () => {
    const bare = params.filter((p) => 0 === (p.schema.description ?? '').trim().length);
    expect(bare.map((p) => p.at)).toEqual([]);
  });

  it('a `since` that takes no string does not offer a git ref', () => {
    const since = params.filter((p) => 'since' === p.name);
    expect(since.length).toBeGreaterThan(1);
    for (const p of since) {
      const takesRef = p.schema.safeParse('main').success;
      expect(/git ref/i.test(p.schema.description ?? ''), p.at).toBe(takesRef);
    }
  });
});
