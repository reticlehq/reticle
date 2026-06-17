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
  /** The existing file could not be parsed as JSON (e.g. jsonc with comments) — bail to manual. */
  MANUAL: 'manual',
} as const;
export type McpMergeStatus = (typeof McpMergeStatus)[keyof typeof McpMergeStatus];

export interface McpMergeResult {
  status: McpMergeStatus;
  /** Full file content to write (2-space JSON, trailing newline). Unchanged when not `apply`. */
  content: string;
}

interface McpConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The iris server entry to add to `mcpServers`, rendered for a manual paste when we can't merge. */
export function irisServerEntry(port: number | undefined): Record<string, unknown> {
  const args =
    port === undefined
      ? [IRIS_PACKAGE, MCP_SUBCOMMAND]
      : [IRIS_PACKAGE, MCP_SUBCOMMAND, PORT_FLAG, String(port)];
  return { command: NPX_COMMAND, args };
}

type ParseResult = { ok: true; config: McpConfigShape } | { ok: false };

function parseConfig(existing: string | null): ParseResult {
  if (existing === null || existing.trim().length === 0) return { ok: true, config: {} };
  try {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== 'object' || parsed === null) return { ok: true, config: {} };
    return { ok: true, config: parsed as McpConfigShape };
  } catch {
    // Comments / trailing commas (jsonc) or genuinely malformed — don't crash, don't rewrite
    // (rewriting would strip the user's comments). The caller bails to a manual instruction.
    return { ok: false };
  }
}

export function mergeMcpConfig(existing: string | null, port: number | undefined): McpMergeResult {
  const parsed = parseConfig(existing);
  if (!parsed.ok) {
    return { status: McpMergeStatus.MANUAL, content: existing ?? '' };
  }
  const config = parsed.config;
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
