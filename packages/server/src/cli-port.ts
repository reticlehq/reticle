/**
 * Port resolution for the iris CLI. Split out so it can be unit-tested independently.
 *
 * Priority (highest → lowest):
 *   1. --port flag  (parsed by parseCliArgs, already overrides defaultPort)
 *   2. IRIS_PORT env var
 *   3. .iris.json "port" field in the cwd  ← per-project isolation
 *   4. IRIS_DEFAULT_PORT (4400)
 */

import { readFileSync } from 'node:fs';

/**
 * Read the port stored in the project's .iris.json (written by `iris init`).
 * Returns undefined if the file is absent, unreadable, or has no valid numeric port.
 */
export function readProjectPort(cwd: string): number | undefined {
  try {
    const raw = readFileSync(`${cwd}/.iris.json`, 'utf8');
    const config: unknown = JSON.parse(raw);
    if (typeof config === 'object' && config !== null) {
      const p = (config as Record<string, unknown>)['port'];
      if (typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536) return p;
    }
  } catch {
    // .iris.json absent or unreadable — fall through to default
  }
  return undefined;
}

/**
 * Resolve the daemon port from all available sources in priority order.
 * Pass `portFlag` when the user explicitly supplied --port; pass `undefined` to fall through.
 */
export function resolvePort(
  portFlag: number | undefined,
  envPort: number | undefined,
  projectPort: number | undefined,
  defaultPort: number,
): number {
  return portFlag ?? envPort ?? projectPort ?? defaultPort;
}
