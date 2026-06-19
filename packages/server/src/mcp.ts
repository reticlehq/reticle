import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isToonable, resultToToon } from '@syrin/iris-protocol';
import { TOOLS, type ToolDeps } from './tools/tools.js';
import { filterTools, TOOL_PROFILE, type ToolProfile } from './tools/profiles.js';
import { runTool } from './tools/invoke-tool.js';
import { log } from './log.js';
import { SERVER_VERSION } from './server-version.js';

const SERVER_INFO = { name: 'iris', version: SERVER_VERSION };

/** First sentence of a description (purpose only) for lean profiles — keeps per-turn def cost
 * down. Cuts at the first sentence-ending period or newline; falls back to a 160-char cap. The
 * first clause retains the essentials (enum hints like "role | text | label" live there). */
function firstSentence(description: string): string {
  const nl = description.indexOf('\n');
  const base = nl >= 0 ? description.slice(0, nl) : description;
  const dot = base.search(/\.\s/);
  const sentence = dot >= 0 ? base.slice(0, dot + 1) : base;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

/**
 * Lean copy of a tool's zod input shape for lean profiles: each parameter's description is
 * truncated to its first sentence via zod's own `.describe()` (which returns a new schema, so the
 * shared shape is never mutated). The per-parameter prose is the bulk of the re-sent-every-turn
 * schema cost; the first clause keeps each param's purpose and any enum hints. Params without a
 * description pass through unchanged.
 */
function leanZodShape(shape: z.ZodRawShape): z.ZodRawShape {
  const out: z.ZodRawShape = {};
  for (const [key, schema] of Object.entries(shape)) {
    const desc = schema.description;
    out[key] = typeof desc === 'string' ? schema.describe(firstSentence(desc)) : schema;
  }
  return out;
}

const ENCODING_ENV = 'IRIS_ENCODING';
const TOON_VALUE = 'toon';

function encodeResult(result: unknown, useToon: boolean): string {
  if (useToon && isToonable(result)) {
    return resultToToon(result as Record<string, unknown>);
  }
  return JSON.stringify(result, null, 2);
}

/**
 * Bridge type that erases the MCP SDK's complex generic pairing between outputSchema and handler
 * return type. Iris exposes tool output as text content (for backwards-compatible MCP clients) AND
 * as structuredContent (for schema-aware clients like @syrin/cli). The SDK generics are correct at
 * the protocol level; we break the link here intentionally so we can register all tools
 * dynamically from a ToolDef array without a generic per-tool call site.
 */
type IrisRegisterTool = (
  name: string,
  config: {
    description: string;
    inputSchema: z.ZodRawShape;
    outputSchema?: z.ZodRawShape;
  },
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>,
) => void;

export function createMcpServer(
  deps: ToolDeps,
  profile: ToolProfile = TOOL_PROFILE.FULL,
): McpServer {
  const useToon = (process.env[ENCODING_ENV] ?? '').toLowerCase() === TOON_VALUE;
  const server = new McpServer(SERVER_INFO);
  // Cast once to our bridge type so every per-tool call site is typed without `any`.
  const registerTool = server.registerTool.bind(server) as unknown as IrisRegisterTool;

  // On a lean profile, advertise only the first sentence of each tool description. The full prose
  // is re-sent to the model on EVERY turn; the first sentence carries the tool's purpose, and
  // param-level schema guidance (kept intact) covers the how. Cuts per-turn token cost in the loop.
  const terse = profile !== TOOL_PROFILE.FULL;
  for (const tool of filterTools(TOOLS, profile)) {
    const config = {
      description: terse ? firstSentence(tool.description) : tool.description,
      inputSchema: terse ? leanZodShape(tool.inputSchema) : tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    };
    registerTool(tool.name, config, async (args: Record<string, unknown>) => {
      try {
        const result = await runTool(tool, deps, args);
        const text = encodeResult(result, useToon);
        if (tool.outputSchema !== undefined) {
          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: result as Record<string, unknown>,
          };
        }
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('tool_error', { tool: tool.name, error: message });
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        };
      }
    });
  }
  return server;
}
