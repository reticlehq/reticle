/**
 * Which coding agents are attached to this daemon, and which one the current tool call came from.
 *
 * Read from MCP `initialize` (`clientInfo.name`), the only honest source: see `client-identity.ts`.
 * Kept per connection, so the HUD can say "Connected: Claude Code" and a note it sent can be marked
 * as seen by the agent whose call actually took it. A pure sink, like the rest of `hooks/`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Friendly names for the clients people know, matched as a lowercase substring of the name the
 * client sent. Ordered: `cursor-vscode` is Cursor, not VS Code. Anything else keeps its own name.
 */
const AGENT_LABELS: readonly (readonly [string, string])[] = [
  ['claude-code', 'Claude Code'],
  ['claude-ai', 'Claude Desktop'],
  ['codex', 'Codex'],
  ['cursor', 'Cursor'],
  ['gemini', 'Gemini CLI'],
  ['antigravity', 'Antigravity'],
  ['windsurf', 'Windsurf'],
  ['cline', 'Cline'],
  ['opencode', 'OpenCode'],
  ['zed', 'Zed'],
  ['visual studio code', 'VS Code'],
  ['vscode', 'VS Code'],
];
const MAX_LABEL = 64;

const byAttach = new Map<string, string>();
const listeners = new Set<() => void>();
const calling = new AsyncLocalStorage<string>();

export function agentLabel(name: string): string {
  const lower = name.toLowerCase();
  const known = AGENT_LABELS.find(([needle]) => lower.includes(needle));
  return (known?.[1] ?? name).slice(0, MAX_LABEL);
}

/** An MCP connection finished its handshake as `name`. */
export function noteAgentAttached(attachId: string, name: string): void {
  byAttach.set(attachId, agentLabel(name));
  changed();
}

/** That connection closed. */
export function noteAgentDetached(attachId: string): void {
  if (byAttach.delete(attachId)) changed();
}

/** The friendly names of the agents attached now, each once. */
export function connectedAgents(): string[] {
  return [...new Set(byAttach.values())];
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
  const own = calling.getStore();
  const label = own === undefined ? undefined : byAttach.get(own);
  if (label !== undefined) return label;
  const all = connectedAgents();
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
