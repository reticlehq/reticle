import { z } from 'zod';
import type { ToolDef, ToolDeps } from './tools.js';
import { runTool } from './invoke-tool.js';

/**
 * On-demand tool loading for MCP — the answer to the per-turn tool-definition tax.
 *
 * A normal MCP server advertises every tool's full description + schema, and the client re-sends
 * all of them to the model on EVERY turn. Measured here: Reticle at ~5.6k–14.6k tokens/turn just for
 * definitions, which dominates a real agent loop and only grows as the tool surface grows.
 *
 * The `dynamic` profile advertises just TWO meta-tools (~hundreds of tokens, fixed regardless of
 * how many real tools exist):
 *   reticle_tools — discover. No args ⇒ a compact catalog (name + one-line summary) of every tool.
 *                names:[...] ⇒ full description + params for just those tools, loaded on demand.
 *   reticle_run   — invoke any tool by name. On a bad/unknown call it returns that tool's params as a
 *                hint, so the model self-corrects without ever needing the schema up front.
 *
 * The model lists once, loads the 2–3 tools it actually needs, and calls them — paying for tool
 * detail only when used, not every turn. Works with any MCP client (no client-side support needed).
 */

/** First sentence (purpose) of a description — keeps the catalog one line per tool. */
function firstSentence(description: string): string {
  const nl = description.indexOf('\n');
  const base = nl >= 0 ? description.slice(0, nl) : description;
  const dot = base.search(/\.\s/);
  const sentence = dot >= 0 ? base.slice(0, dot + 1) : base;
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

interface ParamInfo {
  name: string;
  required: boolean;
  description: string;
}

/** Compact param list from a tool's zod shape — name/required/description (the description already
 * carries the type and any enum hints, so no JSON-Schema machinery is needed). */
function paramInfo(shape: z.ZodRawShape): ParamInfo[] {
  return Object.entries(shape).map(([name, schema]) => ({
    name,
    required: !schema.isOptional(),
    description: schema.description ?? '',
  }));
}

/**
 * Build the two dynamic meta-tools over the full tool table. `reticle_run` dispatches through the same
 * `runTool` chokepoint as a direct call, so session-health splicing and every other invariant hold.
 */
export function buildDynamicTools(allTools: ToolDef[]): ToolDef[] {
  const byName = new Map(allTools.map((t) => [t.name, t]));

  const reticleTools: ToolDef = {
    name: 'reticle_tools',
    description:
      'Discover Reticle tools on demand. Call with no arguments to list every tool (name + one-line summary); call with names:["reticle_network", …] to load full descriptions and parameters for specific tools. Then invoke them with reticle_run. This avoids paying for every tool definition on every turn. To make a verification REUSABLE (record once, replay free forever), the flow workflow lives here: reticle_record_start → act → reticle_flow_save → reticle_flow_verify (and reticle_flow_heal on drift). Load those names when you want to save or re-run a flow.',
    inputSchema: {
      names: z
        .array(z.string())
        .optional()
        .describe('Tool names to load full params for. Omit to list all tools with summaries.'),
    },
    handler: (_deps: ToolDeps, args: Record<string, unknown>) => {
      const names = Array.isArray(args['names'])
        ? (args['names'] as unknown[]).filter((n): n is string => typeof n === 'string')
        : undefined;
      if (names === undefined || names.length === 0) {
        return Promise.resolve({
          tools: allTools.map((t) => ({ name: t.name, summary: firstSentence(t.description) })),
          next: 'Load params with reticle_tools { names:[…] }, then call reticle_run { tool, args }.',
        });
      }
      return Promise.resolve({
        tools: names.map((n) => {
          const t = byName.get(n);
          return t === undefined
            ? { name: n, error: 'unknown tool' }
            : { name: n, description: t.description, params: paramInfo(t.inputSchema) };
        }),
      });
    },
  };

  const reticleRun: ToolDef = {
    name: 'reticle_run',
    description:
      "Invoke any Reticle tool by name (discover names/params first with reticle_tools). On an unknown tool or bad arguments it returns the available names or the tool's params, so you can correct and retry.",
    inputSchema: {
      tool: z.string().describe('Tool name to invoke, e.g. reticle_network.'),
      args: z.record(z.unknown()).optional().describe('Arguments object for that tool.'),
    },
    handler: async (deps: ToolDeps, args: Record<string, unknown>) => {
      const name = typeof args['tool'] === 'string' ? args['tool'] : '';
      const callArgs =
        typeof args['args'] === 'object' && args['args'] !== null
          ? (args['args'] as Record<string, unknown>)
          : {};
      const target = byName.get(name);
      if (target === undefined) {
        return { error: `unknown tool '${name}'`, available: allTools.map((t) => t.name) };
      }
      try {
        return await runTool(target, deps, callArgs);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          tool: name,
          params: paramInfo(target.inputSchema),
          hint: 'fix the arguments and call reticle_run again',
        };
      }
    },
  };

  return [reticleTools, reticleRun];
}
