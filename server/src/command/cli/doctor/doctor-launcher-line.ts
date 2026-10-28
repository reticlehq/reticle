/**
 * The `launcher` row of `reticle doctor`: an agent config starts Reticle from an installed copy
 * (`node <path> mcp`), and that file is gone.
 *
 * `init` registers the installed bin when there is one, so a sandbox boot does not download the
 * package again. When the package is removed later, the agent shows the server as failed and says
 * no more. This row names the path and the command that writes a working entry. It prints only
 * when a launcher is missing, like `version`.
 */
import {
  McpClient,
  RETICLE_NPM_PACKAGE,
  claudeReticleEntries,
  clientSpec,
  detectMcpClients,
  isReticleLauncher,
} from '@reticlehq/init';
import { MCP_SERVER_NAME } from '@reticlehq/core';

/** One agent's `reticle` entry, as its config holds it. */
export interface RegisteredEntry {
  readonly client: string;
  readonly entry: unknown;
}

const SETUP_MCP = `npx ${RETICLE_NPM_PACKAGE} setup mcp`;
/** `setup mcp` keeps an existing Claude Code entry, so that entry goes first. */
const CLAUDE_REMOVE = `claude mcp remove ${MCP_SERVER_NAME} -s user`;

const record = (value: unknown): Record<string, unknown> =>
  'object' === typeof value && null !== value ? (value as Record<string, unknown>) : {};

/** Every string in `command` and `args`, in both the `{ command, args }` and the array shape. */
function strings(entry: unknown): string[] {
  const { command, args } = record(entry);
  return [command, args].flat().filter((v): v is string => 'string' === typeof v);
}

function parsed(text: string | null): unknown {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return undefined;
  }
}

interface ConfigIo {
  readFile(path: string): string | null;
  exists(path: string): boolean;
  homeDir(): string;
}

/**
 * The `reticle` entry of each agent config here: Claude Code's user, local and project scopes, and
 * every file-backed client that `init` registers with.
 */
export function registeredEntries(io: ConfigIo, cwd: string): RegisteredEntry[] {
  const claude = claudeReticleEntries(io, cwd).map((entry) => ({
    client: McpClient.CLAUDE_CODE,
    entry,
  }));
  const others = detectMcpClients(io).map((c) => ({
    client: c.id,
    entry: record(record(parsed(c.existing))[clientSpec(c.id).serversKey])[MCP_SERVER_NAME],
  }));
  return [...claude, ...others].filter((e) => e.entry !== undefined);
}

/** The row text, or undefined when every registered launcher exists. */
export function launcherLine(
  entries: readonly RegisteredEntry[],
  exists: (path: string) => boolean,
): string | undefined {
  for (const { client, entry } of entries) {
    const missing = strings(entry).find((s) => isReticleLauncher(s) && !exists(s));
    if (missing === undefined) {
      continue;
    }
    const fix =
      McpClient.CLAUDE_CODE === client ? `${CLAUDE_REMOVE}, then ${SETUP_MCP}` : SETUP_MCP;
    return `✗ ${client} starts Reticle from ${missing}, and that file does not exist. Run: ${fix}`;
  }
  return undefined;
}
