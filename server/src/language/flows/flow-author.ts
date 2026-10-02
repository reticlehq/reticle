import { homedir } from 'node:os';
import type { FlowFile } from '@reticlehq/core';
import { mcpClientIdentity } from '@/surface/mcp/peer/client-identity.js';
import { readAccountState } from '@/memory/cloud/account-state.js';

/**
 * Who is making a flow right now: the agent that announced itself over MCP, and the person signed in
 * to Reticle on this machine. A key handed over in the environment names no person, so none is
 * written — the cloud can still attribute the push by the key that sent it.
 */
export function flowAuthor(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): FlowFile['author'] {
  const agent = mcpClientIdentity().name;
  const account = readAccountState(home, env);
  const person = account.signedIn ? account.email : undefined;
  if (agent === undefined && person === undefined) return undefined;
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(person === undefined ? {} : { person }),
  };
}
