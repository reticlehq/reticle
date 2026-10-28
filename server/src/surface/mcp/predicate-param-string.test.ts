/**
 * A bare string predicate (`until: "Saved"`) must reach the parse that reads it.
 *
 * Core reads a bare string as visible text. But on a lean surface the advertised predicate
 * parameter was an object schema, so the MCP SDK refused the string before the handler ran, and
 * the agent got `bad_args` for a form the parser accepts.
 */
import { describe, expect, it } from 'vitest';
import { advertisedConfig, advertisedTools } from './mcp.js';
import { TOOL_SURFACE } from '@/surface/tools/tool-surface.js';
import { isPredicateParam } from '@reticlehq/engine/question/predicate/predicate-eval.js';

describe('every advertised predicate parameter takes a bare string', () => {
  for (const surface of [TOOL_SURFACE.DEFAULT, TOOL_SURFACE.MERGED, TOOL_SURFACE.ALL]) {
    it(`on the ${surface} surface`, () => {
      const advertised = advertisedTools(surface);
      const params = advertised.flatMap((tool) => {
        const declared = advertisedConfig(tool, advertised, surface).inputSchema;
        return Object.entries(tool.inputSchema)
          .filter(([, schema]) => isPredicateParam(schema))
          .map(([key]) => ({ name: `${tool.name}.${key}`, schema: declared[key] }));
      });
      expect(params.length, 'no predicate parameter found, so this proves nothing').toBeGreaterThan(
        0,
      );
      for (const { name, schema } of params) {
        expect(schema?.safeParse('Saved').success, name).toBe(true);
        expect(schema?.safeParse({ kind: 'text', contains: 'Saved' }).success, name).toBe(true);
      }
    });
  }
});
