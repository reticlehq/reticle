/**
 * Which coding agents are attached to this daemon, and which one the current tool call came from.
 *
 * Read from MCP `initialize` (`clientInfo.name`), the only honest source: see `client-identity.ts`.
 * Kept per connection, so the HUD can say "Connected: Claude Code" and a note it sent can be marked
 * as seen by the agent whose call actually took it. A pure sink, like the rest of `hooks/`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentClient } from '@reticlehq/core/telemetry';

/**
 * Friendly names for the clients people know, matched as a lowercase substring of the name the
 * client sent, and the closed telemetry value each one reports as. Ordered: `cursor-vscode` is
 * Cursor, not VS Code. Anything else keeps its own name, and reports as `other`.
 */
const AGENT_LABELS: readonly (readonly [string, string, AgentClient])[] = [
  ['claude-code', 'Claude Code', AgentClient.CLAUDE_CODE],
  ['claude-ai', 'Claude Desktop', AgentClient.CLAUDE_DESKTOP],
  ['codex', 'Codex', AgentClient.CODEX],
  ['cursor', 'Cursor', AgentClient.CURSOR],
  ['gemini', 'Gemini CLI', AgentClient.GEMINI_CLI],
  ['antigravity', 'Antigravity', AgentClient.ANTIGRAVITY],
  ['windsurf', 'Windsurf', AgentClient.WINDSURF],
  ['cline', 'Cline', AgentClient.CLINE],
  ['opencode', 'OpenCode', AgentClient.OPENCODE],
  ['zed', 'Zed', AgentClient.ZED],
  ['visual studio code', 'VS Code', AgentClient.VSCODE],
  ['vscode', 'VS Code', AgentClient.VSCODE],
];
const MAX_LABEL = 64;

/** The name each connection's handshake sent, verbatim; labels are derived on read. */
const byAttach = new Map<string, string>();
const listeners = new Set<() => void>();
const calling = new AsyncLocalStorage<string>();

function knownAgent(name: string): (typeof AGENT_LABELS)[number] | undefined {
  const lower = name.toLowerCase();
  return AGENT_LABELS.find(([needle]) => lower.includes(needle));
}

export function agentLabel(name: string): string {
  return (knownAgent(name)?.[1] ?? name).slice(0, MAX_LABEL);
}

/** The closed telemetry value for a client name: never the name itself, which is the client's text. */
export function agentClientOf(name: string | undefined): AgentClient | undefined {
  if (name === undefined || 0 === name.trim().length) return undefined;
  return knownAgent(name)?.[2] ?? AgentClient.OTHER;
}

/** An MCP connection finished its handshake as `name`. */
export function noteAgentAttached(attachId: string, name: string): void {
  byAttach.set(attachId, name);
  changed();
}

/**
 * The agent's own session id per connection, as its MCP server announced it. Kept after the
 * connection closes: a run written at a session's end still needs it.
 * ponytail: never pruned; one short string per MCP connect for the daemon's lifetime.
 */
const sessionByAttach = new Map<string, string>();

/** Connection `attachId` announced the agent session `session`. */
export function noteAgentSession(attachId: string, session: string): void {
  sessionByAttach.set(attachId, session);
}

/** The agent session connection `attachId` announced, if any. */
export function agentSessionOf(attachId: string | undefined): string | undefined {
  return attachId === undefined ? undefined : sessionByAttach.get(attachId);
}

/** The name connection `attachId` gave in its handshake, while it is attached. */
export function agentNameOf(attachId: string | undefined): string | undefined {
  return attachId === undefined ? undefined : byAttach.get(attachId);
}

/** That connection closed. */
export function noteAgentDetached(attachId: string): void {
  if (byAttach.delete(attachId)) changed();
}

/** The friendly names of the agents attached now, each once. */
export function connectedAgents(): string[] {
  return [...new Set([...byAttach.values()].map(agentLabel))];
}

/** Hear an agent attach or leave. Returns the unsubscribe. */
export function onAgentsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Run a tool call as the agent on connection `attachId`, so what it reads is credited to it. */
export function runAsAgent<T>(attachId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return attachId === undefined ? fn() : calling.run(attachId, fn);
}

/**
 * The agent the current call came from; else the only agent attached; else undefined. Two agents
 * and no call to say which is unknown, never a guess.
 */
export function callingAgent(): string | undefined {
  const name = callingClientName();
  return name === undefined ? undefined : agentLabel(name);
}

/** The MCP connection the current call came over, or undefined outside one. */
export function callingAttachId(): string | undefined {
  return calling.getStore();
}

/**
 * The client whose call this is, and nobody else: no fallback to the only agent attached. A run or
 * a journaled action is credited by this — a dashboard Re-verify, which no agent made, was credited
 * to `claude-code` because it was the client last connected.
 */
export function callerClientName(): string | undefined {
  const own = calling.getStore();
  return own === undefined ? undefined : byAttach.get(own);
}

/**
 * The raw client name behind `callingAgent()` — the id a run is credited to, the same string
 * `mcpClientIdentity()` reports, so one agent is one facet on the dashboard.
 */
export function callingClientName(): string | undefined {
  const own = calling.getStore();
  const name = own === undefined ? undefined : byAttach.get(own);
  if (name !== undefined) return name;
  const all = [...new Set(byAttach.values())];
  return 1 === all.length ? all[0] : undefined;
}

/** Tests only. */
export function forgetAgents(): void {
  byAttach.clear();
  listeners.clear();
}

function changed(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a listener never breaks the connection it listens to */
    }
  }
}
