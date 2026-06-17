/**
 * Pure merge of an Iris server entry into a project's `.mcp.json`. Never clobbers an existing
 * `iris` entry — adoption must be idempotent and safe to re-run.
 */

const SERVER_KEY = 'iris';
const NPX_COMMAND = 'npx';
const IRIS_PACKAGE = '@syrin/iris';
const MCP_SUBCOMMAND = 'mcp';
const PORT_FLAG = '--port';

export const McpMergeStatus = {
  APPLY: 'apply',
  ALREADY: 'already',
} as const;
export type McpMergeStatus = (typeof McpMergeStatus)[keyof typeof McpMergeStatus];

export interface McpMergeResult {
  status: McpMergeStatus;
  /** Full file content to write (2-space JSON, trailing newline). Unchanged when `already`. */
  content: string;
}

interface McpConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function irisServerEntry(port: number | undefined): Record<string, unknown> {
  const args =
    port === undefined
      ? [IRIS_PACKAGE, MCP_SUBCOMMAND]
      : [IRIS_PACKAGE, MCP_SUBCOMMAND, PORT_FLAG, String(port)];
  return { command: NPX_COMMAND, args };
}

function parseConfig(existing: string | null): McpConfigShape {
  if (existing === null || existing.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(existing);
  if (typeof parsed !== 'object' || parsed === null) return {};
  return parsed as McpConfigShape;
}

export function mergeMcpConfig(existing: string | null, port: number | undefined): McpMergeResult {
  const config = parseConfig(existing);
  const servers = config.mcpServers ?? {};

  if (Object.prototype.hasOwnProperty.call(servers, SERVER_KEY)) {
    return { status: McpMergeStatus.ALREADY, content: existing ?? '' };
  }

  const merged: McpConfigShape = {
    ...config,
    mcpServers: { ...servers, [SERVER_KEY]: irisServerEntry(port) },
  };
  return { status: McpMergeStatus.APPLY, content: `${JSON.stringify(merged, null, 2)}\n` };
}
