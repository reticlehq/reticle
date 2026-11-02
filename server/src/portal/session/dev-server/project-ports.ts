/**
 * Ports this project sets in its `.env` files (reticle#1543).
 *
 * The no-session scan probes a list of well-known ports, the ports the build plugins announced, a
 * port pinned in the `dev` script (#1367), and the ports of earlier sessions. An app that reads its
 * port from `.env` is on none of those. Reported from React apps on Windows: a preview server on
 * :3020, started by a Node script, and the answer said no app was running and suggested a dev
 * server, which would start a duplicate.
 *
 * This only ADDS candidates to the scan. The scan still decides which of them answer like a dev
 * server.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The `.env` files a Node dev setup reads, in the order dotenv-style loaders read them. */
export const ENV_PORT_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
] as const;

/** One `PORT=3020` line. `export`, quotes and a trailing comment are allowed. */
const ENV_PORT_LINE = /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{1,5})["']?\s*(?:#.*)?$/gm;

/** The highest TCP port. */
const MAX_PORT = 65_535;

function toPort(digits: string | undefined): number | undefined {
  if (digits === undefined) {
    return undefined;
  }
  const port = Number(digits);
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The ports the project's `.env` files set with `PORT=`.
 *
 * Every file is read, not only the one a given loader would pick: the scan only probes candidates,
 * so an extra port costs one connection attempt, while a missed one is the defect this fixes.
 */
export function envFilePorts(
  directory: string,
  read: (path: string) => string | undefined = readText,
): number[] {
  const ports = new Set<number>();
  for (const file of ENV_PORT_FILES) {
    const text = read(join(directory, file));
    if (text === undefined) {
      continue;
    }
    for (const match of text.matchAll(ENV_PORT_LINE)) {
      const port = toPort(match[1]);
      if (port !== undefined) {
        ports.add(port);
      }
    }
  }
  return [...ports];
}
