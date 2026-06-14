import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isToonable, resultToToon } from '@syrin/iris-protocol';
import { TOOLS, type ToolDeps } from './tools/tools.js';
import { filterTools, TOOL_PROFILE, type ToolProfile } from './tools/profiles.js';
import { runTool } from './tools/invoke-tool.js';
import { log } from './log.js';

interface PackageJson {
  version: string;
}
const _pkg: PackageJson = createRequire(import.meta.url)('../package.json') as PackageJson;
const SERVER_INFO = { name: 'iris', version: _pkg.version };

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

  for (const tool of filterTools(TOOLS, profile)) {
    const config = {
      description: tool.description,
      inputSchema: tool.inputSchema,
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
