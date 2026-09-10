/**
 * A numeric parameter advertised as a predicate object.
 *
 * Lean profiles replace the full predicate union with a compact description, because the union is
 * 72% of the advertised input schema and is re-sent every turn. The replacement picks its targets by
 * NAME: `PREDICATE_PARAMS = new Set(['predicate', 'until'])`.
 *
 * But `until` is overloaded on this surface. The act/assert family uses it for a predicate; the READ
 * family — reticle_observe, reticle_network, reticle_console — uses it for a NUMBER, an upper cursor
 * bound ("the span between two acts"). Under the DEFAULT hybrid profile all three were advertised to
 * the agent as `Predicate object: { kind, ...fields }`, typed as a record.
 *
 * An agent that believes the schema passes a predicate object, and the handler does
 * `asNumber(args['until'])` → undefined → the cursor bound is silently dropped and the tool answers
 * over the wrong window. A wrong answer that looks like an answer, which is the exact failure class
 * this product exists to catch.
 *
 * The fix is to key on the SCHEMA rather than the name: replace a parameter because it IS a
 * predicate, not because of what it is called.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { advertisedTools, advertisedConfig } from './mcp/mcp.js';
import { TOOL_SURFACE } from './tools/tool-surface.js';

const PREDICATE_MARKER = 'Predicate object';

/** Tools where `until` is a numeric cursor bound, not a predicate. */
const CURSOR_TOOLS = ['reticle_observe', 'reticle_network', 'reticle_console'];

describe('the lean profile does not retype a numeric parameter as a predicate', () => {
  const advertised = advertisedTools(TOOL_SURFACE.DEFAULT);
  const describedAs = (toolName: string, param: string): string => {
    const tool = advertised.find((t) => t.name === toolName);
    if (tool === undefined) return '';
    const shape = advertisedConfig(tool, advertised, TOOL_SURFACE.DEFAULT).inputSchema;
    return shape[param]?.description ?? '';
  };

  it.each(CURSOR_TOOLS)('%s.until is still described as a cursor bound', (toolName) => {
    const text = describedAs(toolName, 'until');
    expect(text, `${toolName}.until is advertised as a predicate`).not.toContain(PREDICATE_MARKER);
    expect(text.toLowerCase(), `${toolName}.until should say what it is`).toMatch(
      /cursor|bound|span/,
    );
  });

  it('while a REAL predicate parameter still gets the compact grammar', () => {
    // The saving this mechanism exists for must survive the fix.
    expect(describedAs('reticle_wait_for', 'predicate')).toContain(PREDICATE_MARKER);
    expect(describedAs('reticle_act_and_wait', 'until')).toContain(PREDICATE_MARKER);
  });
});

/**
 * The general form of the same rule: the lean profile may retype a parameter ONLY when that
 * parameter is genuinely the predicate union.
 *
 * The specific cases above pin the three tools that were broken. This pins the MECHANISM, so a
 * future compaction that starts rewriting some other parameter — by name, by position, by
 * convenience — fails here rather than shipping a schema that lies about a type.
 *
 * The sanity assertion matters as much as the rule: if the probe ever stops seeing the retype it is
 * supposed to police (a zod upgrade changing wrapper shapes, say), this suite would pass by
 * observing nothing at all.
 */
describe('the lean profile retypes predicates and nothing else', () => {
  const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny =>
    schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodTypeAny) : schema;
  const kindOf = (schema: z.ZodTypeAny): string => unwrap(schema).constructor.name;

  const full = advertisedTools(TOOL_SURFACE.ALL);
  const hybrid = advertisedTools(TOOL_SURFACE.DEFAULT);
  const fullShapes = new Map(full.map((tool) => [tool.name, tool.inputSchema]));

  const retyped = (): string[] => {
    const out: string[] = [];
    for (const tool of hybrid) {
      const lean = advertisedConfig(tool, hybrid, TOOL_SURFACE.DEFAULT).inputSchema;
      const original = fullShapes.get(tool.name);
      if (original === undefined) continue;
      for (const [key, schema] of Object.entries(lean)) {
        const before = original[key];
        if (before === undefined) continue;
        if (kindOf(schema) !== kindOf(before)) out.push(`${tool.name}.${key}`);
      }
    }
    return out;
  };

  it('still SEES a retype at all — otherwise this proves nothing', () => {
    expect(retyped().length).toBeGreaterThan(0);
  });

  it('and every parameter it retypes is a predicate', () => {
    const notPredicates = retyped().filter((entry) => {
      const param = entry.split('.')[1] ?? '';
      return param !== 'predicate' && param !== 'until';
    });
    expect(
      notPredicates,
      `lean profile retyped non-predicate params: ${notPredicates.join(', ')}`,
    ).toEqual([]);
  });

  it("never retypes the read family's numeric cursor bound", () => {
    for (const tool of CURSOR_TOOLS) {
      expect(retyped(), `${tool}.until must keep its own type`).not.toContain(`${tool}.until`);
    }
  });
});
