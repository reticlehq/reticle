/**
 * Global Cursor registration for `reticle init`. Cursor has no CLI, but its global MCP config is a
 * small dedicated file (`~/.cursor/mcp.json`) — safe to merge directly (unlike `~/.claude.json`).
 * We add the `reticle` server once at this global path so every project picks it up. Unparseable
 * (jsonc/comment) files bail to manual rather than being rewritten.
 */

import { NPX, MCP_SERVER_NAME, npxServerArgs } from './mcp.js';

/** Path of Cursor's global MCP config, relative to the user's home directory. */
export const CURSOR_MCP_RELPATH = '.cursor/mcp.json';
/** The directory whose presence signals Cursor is installed for this user. */
export const CURSOR_DIR_RELPATH = '.cursor';

export const CursorMergeStatus = {
  APPLY: 'apply',
  ALREADY: 'already',
  MANUAL: 'manual',
} as const;
export type CursorMergeStatus = (typeof CursorMergeStatus)[keyof typeof CursorMergeStatus];

interface CursorMergeResult {
  status: CursorMergeStatus;
  /** Full file content to write (2-space JSON, trailing newline). Unchanged when not `apply`. */
  content: string;
}

interface CursorConfigShape {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function cursorServerEntry(): Record<string, unknown> {
  return { command: NPX, args: npxServerArgs() };
}

type ParseResult = { ok: true; config: CursorConfigShape } | { ok: false };

function parseConfig(existing: string | null): ParseResult {
  if (existing === null || existing.trim().length === 0) return { ok: true, config: {} };
  try {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== 'object' || parsed === null) return { ok: true, config: {} };
    return { ok: true, config: parsed as CursorConfigShape };
  } catch {
    return { ok: false };
  }
}

export function mergeCursorConfig(existing: string | null): CursorMergeResult {
  const parsed = parseConfig(existing);
  if (!parsed.ok) {
    return { status: CursorMergeStatus.MANUAL, content: existing ?? '' };
  }
  const config = parsed.config;
  const servers = config.mcpServers ?? {};
  if (Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_NAME)) {
    return { status: CursorMergeStatus.ALREADY, content: existing ?? '' };
  }
  const merged: CursorConfigShape = {
    ...config,
    mcpServers: { ...servers, [MCP_SERVER_NAME]: cursorServerEntry() },
  };
  return { status: CursorMergeStatus.APPLY, content: `${JSON.stringify(merged, null, 2)}\n` };
}
