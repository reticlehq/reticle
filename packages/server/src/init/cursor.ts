/**
 * Global Cursor registration for `reticle init`. Cursor has no CLI, but its global MCP config is a
 * small dedicated file (`~/.cursor/mcp.json`) — safe to merge directly (unlike `~/.claude.json`).
 * We add the `reticle` server once at this global path so every project picks it up. Unparseable
 * (jsonc/comment) files bail to manual rather than being rewritten.
 */

import { NPX, MCP_SERVER_NAME, npxServerArgs, isReticleRegistration } from './mcp.js';

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
  if (null === existing || 0 === existing.trim().length) return { ok: true, config: {} };
  try {
    const parsed: unknown = JSON.parse(existing);
    // Valid JSON that is not a PLAIN OBJECT — `[]`, `3`, `"x"`, `null` — used to fall through to an
    // empty config, and the file was then rewritten wholesale. Unparseable JSON was already handled
    // conservatively; this adjacent case destroyed the file instead. Whatever is in there is the
    // user's, and we do not understand it, so we do not touch it.
    if (typeof parsed !== 'object' || null === parsed || Array.isArray(parsed))
      return { ok: false };
    return { ok: true, config: parsed as CursorConfigShape };
  } catch {
    return { ok: false };
  }
}

/**
 * Should this entry be left exactly as it is?
 *
 * Two different reasons to leave one alone, and only one of them is "it is correct":
 *   - it already matches what we would write; or
 *   - it is not an entry WE wrote. Somebody pointing `reticle` at their own local build is a
 *     deliberate choice, and silently replacing it with the published npx command would break their
 *     setup to fix a problem they do not have.
 *
 * What IS repaired is a stale entry of our own shape — an old pin, a command that has moved — which
 * presence-only idempotency reported as "already registered" and never fixed, so an upgrade could
 * not repair the thing an upgrade exists to repair. A WRONG entry counts as ours to repair too:
 * `["@reticlehq/core","mcp"]` was reported from the field, and `core` has no MCP server in it.
 */
function leaveEntryAlone(existing: unknown): boolean {
  if (JSON.stringify(existing) === JSON.stringify(cursorServerEntry())) return true;
  if (typeof existing !== 'object' || null === existing) return true;
  const record = existing as { command?: unknown; args?: unknown };
  const tokens = [record.command, record.args].flat().filter((v) => 'string' === typeof v);
  return !isReticleRegistration(tokens);
}

export function mergeCursorConfig(existing: string | null): CursorMergeResult {
  const parsed = parseConfig(existing);
  if (!parsed.ok) {
    return { status: CursorMergeStatus.MANUAL, content: existing ?? '' };
  }
  const config = parsed.config;
  const servers = config.mcpServers ?? {};
  // Presence alone used to mean "already registered", so a `reticle` entry left by an older release —
  // a command that no longer exists, or a stale pin — was reported done and never repaired. An
  // upgrade could not fix a bad entry, which is exactly when it needs to. Only OUR key is replaced;
  // every other server and top-level key is carried through untouched by the spread below.
  if (
    Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_NAME) &&
    leaveEntryAlone(servers[MCP_SERVER_NAME])
  ) {
    return { status: CursorMergeStatus.ALREADY, content: existing ?? '' };
  }
  const merged: CursorConfigShape = {
    ...config,
    mcpServers: { ...servers, [MCP_SERVER_NAME]: cursorServerEntry() },
  };
  return { status: CursorMergeStatus.APPLY, content: `${JSON.stringify(merged, null, 2)}\n` };
}
