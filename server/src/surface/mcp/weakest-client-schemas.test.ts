/**
 * What the weakest client sees: every advertised tool's input schema, converted the way the SDK
 * converts it.
 *
 * THE NAMED INCIDENT: the recursive `until` predicate silently degraded to `any`. `Predicate` is defined with `z.lazy`
 * so a composite can hold composites, and a converter run WITHOUT the SDK's own options flattens
 * that to `{}` — a parameter that accepts anything and teaches nothing. The tool still registered,
 * the surface still listed, and every client that reads the schema to build its call lost the
 * entire grammar of the one argument that decides a verdict. Found when the harness was ported and
 * its own converter disagreed with the server's.
 *
 * The OTHER half of the weakest-client question — how many tools the menu holds, given that some
 * clients drop a whole server whose surface is too large — is NOT here. `surface-sizes.test.ts`
 * already pins every surface's size AND caps it AND gates the one sentence in SKILL.md allowed to
 * state a number. A second copy of those counts is the "two answers to one question" failure this
 * package keeps paying for, and it would have been exactly that: writing one was how I found out
 * the first one existed, and its own gate is what told me.
 *
 * Reads the LIVE surface through `advertisedTools`, never a reimplementation of it —
 * `advertised-names-are-real.test.ts` next door is the incident that rule comes from.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { advertisedTools } from '@/surface/mcp/mcp.js';
import { TOOL_SURFACE, type ToolSurface } from '@/surface/tools/tool-surface.js';

/**
 * Exactly what `McpServer` does to an input schema before it goes on the wire.
 *
 * Copied from the SDK's `registerTool` path rather than approximated: an approximation that
 * disagrees with the real conversion is how the degradation went unseen the first time.
 */
const asClientSees = (shape: z.ZodRawShape): Record<string, unknown> =>
  toJsonSchemaCompat(z.object(shape), {
    strictUnions: true,
    pipeStrategy: 'input',
  });

/** A schema that constrains NOTHING: `{}`, `true`, or a bare `any`. */
function isDegenerate(schema: unknown): boolean {
  if (true === schema) return true;
  if ('object' !== typeof schema || null === schema) return false;
  const keys = Object.keys(schema).filter((k) => 'description' !== k && 'title' !== k);
  return 0 === keys.length;
}

/** Every surface this package can actually serve. */
const SURFACES: readonly ToolSurface[] = [
  TOOL_SURFACE.DEFAULT,
  TOOL_SURFACE.ALL,
  TOOL_SURFACE.LEAN,
  TOOL_SURFACE.VERIFY,
  TOOL_SURFACE.MERGED,
];

describe('every advertised tool describes its arguments to the weakest client', () => {
  for (const surface of SURFACES) {
    it(`has a non-degenerate schema for every parameter on the ${surface} surface`, () => {
      const empty: string[] = [];
      for (const tool of advertisedTools(surface)) {
        const json = asClientSees(tool.inputSchema);
        const properties = json['properties'];
        // A tool with no parameters is legitimate; a tool with parameters and no properties is the
        // whole grammar going missing, which is the shape this exists to catch.
        if (0 === Object.keys(tool.inputSchema).length) continue;
        if ('object' !== typeof properties || null === properties) {
          empty.push(`${tool.name}: the whole input schema converted to nothing`);
          continue;
        }
        for (const [param, schema] of Object.entries(properties)) {
          if (isDegenerate(schema)) empty.push(`${tool.name}.${param}`);
        }
      }
      expect(
        empty,
        'these parameters convert to a schema that accepts anything, so a client reading the ' +
          'surface to build its call learns nothing about them. The recursive predicate did this ' +
          "when converted without the SDK's own options, and the tool still registered.",
      ).toEqual([]);
    });
  }

  /*
   * The `until` predicate specifically, because it is the parameter the incident was about and the
   * one argument in the product that decides a verdict. A generic sweep would pass the day someone
   * removes it from the default surface.
   */
  it('keeps the recursive predicate grammar, rather than flattening it to anything', () => {
    const withPredicate = advertisedTools(TOOL_SURFACE.ALL).find(
      (tool) => 'until' in tool.inputSchema,
    );
    expect(withPredicate, 'no advertised tool takes an `until`').toBeDefined();
    if (withPredicate === undefined) return;
    const json = asClientSees(withPredicate.inputSchema);
    const until = (json['properties'] as Record<string, unknown> | undefined)?.['until'];
    expect(isDegenerate(until)).toBe(false);
  });
});
