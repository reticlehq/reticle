/**
 * Which coding agents have connected to Reticle on this machine, by name.
 *
 * `attach-memory.ts` records that SOME client attached on a port. It cannot say which one, so with
 * two agents a healthy one hides a broken one. This record keeps the client that the MCP
 * `initialize` handshake names, as its closed `AgentClient` value. It is machine wide, because the
 * installer runs before there is a project and therefore before there is a port.
 *
 * The proxy writes it when the request arrives. It records a fact that happened, never an inference
 * from a config file. Best-effort in both directions: a hint never breaks the client path.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RECORD_FILE = 'agents-connected.json';
const INITIALIZE_METHOD = 'initialize';

/** The `AgentClient` values of every agent that has connected. Empty on a missing or broken file. */
export function connectedAgentClients(stateDir: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, RECORD_FILE), 'utf8'));
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => 'string' === typeof v) : [],
    );
  } catch {
    return new Set();
  }
}

/** Record that `client` (an `AgentClient` value) connected. Written once per client. */
export function rememberAgentConnected(stateDir: string, client: string): void {
  const known = connectedAgentClients(stateDir);
  if (known.has(client)) {
    return;
  }
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, RECORD_FILE), JSON.stringify([...known, client]), 'utf8');
  } catch {
    // An unwritable state home is reported elsewhere; it must not break the client path.
  }
}

/** `clientInfo.name` of an MCP `initialize` request line, or undefined for any other line. */
export function initializeClientName(line: string): string | undefined {
  try {
    const msg: unknown = JSON.parse(line);
    if ('object' !== typeof msg || null === msg) {
      return undefined;
    }
    const { method, params } = msg as { method?: unknown; params?: unknown };
    if (INITIALIZE_METHOD !== method || 'object' !== typeof params || null === params) {
      return undefined;
    }
    const info = (params as { clientInfo?: unknown }).clientInfo;
    const name =
      'object' === typeof info && null !== info ? (info as { name?: unknown }).name : undefined;
    return 'string' === typeof name && 0 < name.length ? name : undefined;
  } catch {
    return undefined;
  }
}
