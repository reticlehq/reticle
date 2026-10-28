/**
 * One next step for each coding agent, and whether each one really connected.
 *
 * Registration writes a config. An agent reads that config only at a time the client decides, so
 * "registered" is not "the agent has the tools". This file names, per client, the one step that
 * loads the tools, and reads which agents did connect (`agents-connected.ts`) to say so.
 *
 * Only the Claude Code plugin gets "no restart". Its docs say `/reload-plugins` loads it. For every
 * other client the step is the conservative one: their docs do not say a running session picks up a
 * new server.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  claudeAddCommand,
  claudeHasReticle,
  claudeRemoveUserCommand,
  clientSpec,
  codexNamesOurServer,
  ConfigFormat,
  detectMcpClients,
  McpClient,
  type ClientSpec,
} from '@reticlehq/init';
import { MCP_SERVER_NAME } from '@reticlehq/core';
import { AgentClient } from '@reticlehq/core/telemetry';
import type { SetupMcpResult } from './setup-mcp.js';

/** What registration did for one client. */
export const AgentReg = {
  /** The Claude Code plugin carries Reticle. */
  PLUGIN: 'plugin',
  ADDED: 'added',
  ALREADY: 'already',
  FAILED: 'failed',
  MANUAL: 'manual',
  /** Found, and Reticle is not in its config. Read-only callers (`status`) only. */
  MISSING: 'missing',
} as const;
export type AgentReg = (typeof AgentReg)[keyof typeof AgentReg];

export interface AgentRow {
  readonly id: McpClient;
  readonly reg: AgentReg;
  /** The config path for a hand edit. */
  readonly path?: string;
  /** The command to retry a failed CLI registration, with the launcher that run used. */
  readonly retry?: string;
  /** The plugin AND a user-scope `reticle` entry: the client has two servers. */
  readonly duplicate?: boolean;
}

interface AgentStep {
  /** The name a person knows the client by. */
  readonly name: string;
  /** The value `agents-connected.ts` records for it. */
  readonly agent: AgentClient;
  /** The one step that makes the client load a newly added server. */
  readonly step: string;
}

/** The one table of client to next step. Change a step here, nowhere else. */
const AGENT_STEPS: Record<McpClient, AgentStep> = {
  [McpClient.CLAUDE_CODE]: {
    name: 'Claude Code',
    agent: AgentClient.CLAUDE_CODE,
    step: 'restart Claude Code, then /mcp shows reticle',
  },
  [McpClient.CURSOR]: {
    name: 'Cursor',
    agent: AgentClient.CURSOR,
    step: 'restart Cursor, then turn Reticle on in Settings › MCP',
  },
  [McpClient.CODEX]: {
    name: 'Codex',
    agent: AgentClient.CODEX,
    step: 'restart Codex, then /mcp shows reticle',
  },
  [McpClient.GEMINI]: {
    name: 'Gemini CLI',
    agent: AgentClient.GEMINI_CLI,
    step: 'restart Gemini CLI, then /mcp shows reticle',
  },
  [McpClient.WINDSURF]: {
    name: 'Windsurf',
    agent: AgentClient.WINDSURF,
    step: 'restart Windsurf, then turn Reticle on in its MCP settings',
  },
  [McpClient.VSCODE]: {
    name: 'VS Code',
    agent: AgentClient.VSCODE,
    step: 'run "Developer: Reload Window" in VS Code',
  },
  [McpClient.OPENCODE]: {
    name: 'OpenCode',
    agent: AgentClient.OPENCODE,
    step: 'restart OpenCode',
  },
  [McpClient.ANTIGRAVITY]: {
    name: 'Antigravity',
    agent: AgentClient.ANTIGRAVITY,
    step: 'restart Antigravity',
  },
};

const NextStepCopy = {
  HEADING: 'Your agents:',
  PLUGIN_ACTIVE: 'plugin active: type /reload-plugins if it is open',
  PLUGIN_NOT_CONNECTED: 'start Claude Code, or type /reload-plugins in an open session',
  ADDED: 'added: ',
  ALREADY: 'already set up',
  NOT_ADDED: 'not added: ',
  FAILED: 'registration failed: ',
  FAILED_FILE: 'check the permissions of its config file, then run `reticle setup mcp`',
  MANUAL_HEAD: 'add the reticle entry to ',
  MANUAL_TAIL: ' by hand',
  MISSING: 'not added: run `reticle setup mcp`',
  CONNECTED_HEAD: 'Connected: ',
  CONNECTED_TAIL: ' ✓',
  NOT_CONNECTED: ' not connected yet: ',
  DUPLICATE:
    '    ⚠ a user-scope reticle server is registered too, so Claude Code has two. Remove it: ',
} as const;

const NAME_COLUMN = Math.max(...Object.values(AGENT_STEPS).map((s) => s.name.length)) + 2;

/**
 * The rows for one `setupMcp` run, in its order.
 *
 * @param launcher the installed bin that run registered (`SetupMcpIo.launcher`), so a retry line
 *   names the same command.
 */
export function agentRows(result: SetupMcpResult, launcher?: string): AgentRow[] {
  const known = (id: string): id is McpClient => id in AGENT_STEPS;
  const rows: AgentRow[] = [];
  for (const id of result.detected) {
    if (!known(id)) {
      continue;
    }
    if (result.pluginActive.includes(id)) {
      rows.push(pluginRow(id, result.duplicates.includes(id)));
      continue;
    }
    const manual = result.manual.find((m) => m.id === id);
    if (manual !== undefined) {
      rows.push({ id, reg: AgentReg.MANUAL, path: manual.configPath });
    } else if (result.failed.includes(id)) {
      rows.push(
        McpClient.CLAUDE_CODE === id
          ? { id, reg: AgentReg.FAILED, retry: claudeAddCommand(launcher).display }
          : { id, reg: AgentReg.FAILED },
      );
    } else if (result.alreadyThere.includes(id)) {
      rows.push({ id, reg: AgentReg.ALREADY });
    } else if (result.registered.includes(id)) {
      rows.push({ id, reg: AgentReg.ADDED });
    }
  }
  return rows;
}

function pluginRow(id: McpClient, duplicate: boolean): AgentRow {
  return duplicate ? { id, reg: AgentReg.PLUGIN, duplicate } : { id, reg: AgentReg.PLUGIN };
}

function failedStep(row: AgentRow): string {
  return row.retry === undefined ? NextStepCopy.FAILED_FILE : `run \`${row.retry}\``;
}

/** What one row says before anything is known about the connection. */
function registrationText(row: AgentRow): string {
  const { step } = AGENT_STEPS[row.id];
  switch (row.reg) {
    case AgentReg.PLUGIN:
      return NextStepCopy.PLUGIN_ACTIVE;
    case AgentReg.ADDED:
      return `${NextStepCopy.ADDED}${step}`;
    case AgentReg.ALREADY:
      return NextStepCopy.ALREADY;
    case AgentReg.FAILED:
      return `${NextStepCopy.FAILED}${failedStep(row)}`;
    case AgentReg.MANUAL:
      return `${NextStepCopy.NOT_ADDED}${NextStepCopy.MANUAL_HEAD}${row.path ?? ''}${NextStepCopy.MANUAL_TAIL}`;
    case AgentReg.MISSING:
      return NextStepCopy.MISSING;
  }
}

/** The "Your agents:" block: one line per client, each with its own next step. */
export function agentLines(rows: readonly AgentRow[]): string[] {
  if (0 === rows.length) {
    return [];
  }
  return [
    NextStepCopy.HEADING,
    ...rows.flatMap((row) => {
      const line = `  ${AGENT_STEPS[row.id].name.padEnd(NAME_COLUMN)}${registrationText(row)}`;
      return true === row.duplicate
        ? [line, `${NextStepCopy.DUPLICATE}${claudeRemoveUserCommand()}`]
        : [line];
    }),
  ];
}

/** A row whose client has Reticle in its config, so a connection can be waited for. */
function isRegistered(row: AgentRow): boolean {
  return AgentReg.PLUGIN === row.reg || AgentReg.ADDED === row.reg || AgentReg.ALREADY === row.reg;
}

/** The clients worth waiting for: the ones that have Reticle registered. */
export function awaitedClients(rows: readonly AgentRow[]): AgentClient[] {
  return rows.filter(isRegistered).map((row) => AGENT_STEPS[row.id].agent);
}

/** One agent, as `reticle status` reports it. */
export interface AgentStatus {
  readonly name: string;
  readonly connected: boolean;
  /** The step still missing. Absent when connected. */
  readonly next?: string;
  /** The line a person reads: "Connected: Cursor ✓", or the name and the step still missing. */
  readonly said: string;
}

function missingStep(row: AgentRow): string {
  if (AgentReg.PLUGIN === row.reg) {
    return NextStepCopy.PLUGIN_NOT_CONNECTED;
  }
  if (isRegistered(row)) {
    return AGENT_STEPS[row.id].step;
  }
  return registrationText(row);
}

/** Per client: connected, or the exact step still missing. */
export function agentStatuses(
  rows: readonly AgentRow[],
  connected: ReadonlySet<string>,
): AgentStatus[] {
  return rows.map((row) => {
    const { name, agent } = AGENT_STEPS[row.id];
    if (isRegistered(row) && connected.has(agent)) {
      return {
        name,
        connected: true,
        said: `${NextStepCopy.CONNECTED_HEAD}${name}${NextStepCopy.CONNECTED_TAIL}`,
      };
    }
    const next = missingStep(row);
    const said = isRegistered(row)
      ? `${name}${NextStepCopy.NOT_CONNECTED}${next}`
      : `${name} ${next}`;
    return { name, connected: false, next, said };
  });
}

/** The lines the installer prints after its wait. */
export function connectionLines(
  rows: readonly AgentRow[],
  connected: ReadonlySet<string>,
): string[] {
  return agentStatuses(rows, connected).map((status) => status.said);
}

/** The clock the wait runs on. Injected, so a test does not wait. */
export interface WaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Poll `read` until every client in `want` has connected, or `budgetMs` has passed. Returns the
 * last read. Bounded: it never waits longer than the budget.
 */
export async function waitForAgents(
  want: readonly string[],
  read: () => ReadonlySet<string>,
  clock: WaitClock,
  budgetMs: number,
  pollMs: number,
): Promise<ReadonlySet<string>> {
  const start = clock.now();
  let seen = read();
  while (!want.every((client) => seen.has(client)) && clock.now() - start < budgetMs) {
    await clock.sleep(pollMs);
    seen = read();
  }
  return seen;
}

const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** `$CLAUDE_CONFIG_DIR`, else home: where Claude Code keeps `.claude.json`. */
export function claudeStateDir(): string {
  return process.env[CLAUDE_CONFIG_DIR_ENV] ?? homedir();
}

/** What `installedAgentRows` reads. It never writes. */
export interface AgentProbe {
  exists(path: string): boolean;
  readFile(path: string): string | null;
  homeDir(): string;
}

const CLAUDE_STATE_FILE = '.claude.json';

/**
 * Does this client's config name a `reticle` server, in any shape?
 *
 * Presence, not "the entry we would write now". An entry that starts an installed launcher, or an
 * older npx entry, still starts Reticle. `setup mcp` repairs a stale entry; `status` only reports
 * whether one is there. A file that does not parse reads as absent.
 */
function configNamesReticle(spec: ClientSpec, existing: string | null): boolean {
  if (ConfigFormat.TOML === spec.format) {
    return codexNamesOurServer(existing, spec.serversKey);
  }
  if (null === existing) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(existing);
    const servers =
      'object' === typeof parsed && null !== parsed
        ? (parsed as Record<string, unknown>)[spec.serversKey]
        : undefined;
    return 'object' === typeof servers && null !== servers && MCP_SERVER_NAME in servers;
  } catch {
    return false;
  }
}

/**
 * The agents on this machine and whether Reticle is in each config, read only. For `reticle status`,
 * which must not register anything and must not spawn a client CLI.
 *
 * @param claudeStateDir the directory that holds `.claude.json`: `$CLAUDE_CONFIG_DIR`, else home.
 */
export function installedAgentRows(
  io: AgentProbe,
  projectDir: string | undefined,
  pluginActive: boolean,
  claudeStateDir: string = io.homeDir(),
): AgentRow[] {
  const rows: AgentRow[] = [];
  if (pluginActive) {
    // A user-scope entry next to the plugin is a second server.
    rows.push(pluginRow(McpClient.CLAUDE_CODE, claudeHasReticle(io, undefined, claudeStateDir)));
  } else if (claudeHasReticle(io, projectDir, claudeStateDir)) {
    rows.push({ id: McpClient.CLAUDE_CODE, reg: AgentReg.ALREADY });
  } else if (io.exists(join(claudeStateDir, CLAUDE_STATE_FILE))) {
    rows.push({ id: McpClient.CLAUDE_CODE, reg: AgentReg.MISSING });
  }
  for (const client of detectMcpClients(io)) {
    rows.push({
      id: client.id,
      reg: configNamesReticle(clientSpec(client.id), client.existing)
        ? AgentReg.ALREADY
        : AgentReg.MISSING,
    });
  }
  return rows;
}
