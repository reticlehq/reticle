/**
 * Which project the MCP client that is calling right now is standing in.
 *
 * One daemon serves every project on the machine. `everConnected` and the first-run wiring used to
 * read the directory the daemon was started in, so a second project's first `reticle_session` was
 * answered with the first project's closed tab. The proxy knows its own cwd, which is the project
 * the agent launched it from, and the HTTP door puts it on this context for the call.
 *
 * Same shape as `driven-by`: set around the request, read wherever the call is answered, gone when
 * the call is. Absent means an in-process caller that has no separate project, and the daemon's own
 * directory is still the answer.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { MCP_CLIENT_DIRECTORY_HEADER } from '@reticlehq/core';

const current = new AsyncLocalStorage<string>();

/** The calling client's project directory, or undefined when this call did not name one. */
export function callingClientDirectory(): string | undefined {
  return current.getStore();
}

export function runWithClientDirectory<T>(directory: string, fn: () => T): T {
  return current.run(resolve(directory), fn);
}

/**
 * The absolute directory a client named, or undefined when the header is absent or not a path.
 *
 * Relative values are dropped rather than resolved against the daemon's cwd: that would quietly
 * turn "the client's project" back into "wherever this process was started".
 */
export function clientDirectoryFromHeader(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers[MCP_CLIENT_DIRECTORY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if ('string' !== typeof value || !isAbsolute(value)) return undefined;
  return resolve(value);
}

/**
 * The directory this peer may name, or undefined.
 *
 * A remote client can present the pairing token, so the header is honored only from loopback.
 * Otherwise it could point `init` at a path it chose.
 */
export function clientDirectoryFromPeer(
  loopback: boolean,
  headers: IncomingHttpHeaders,
): string | undefined {
  if (!loopback) return undefined;
  return clientDirectoryFromHeader(headers);
}
