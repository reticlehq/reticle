/**
 * Port resolution for the reticle CLI. Split out so it can be unit-tested independently.
 *
 * Priority (highest → lowest):
 *   1. --port flag  (parsed by parseCliArgs, already overrides defaultPort)
 *   2. RETICLE_PORT env var
 *   3. .reticle.json "port" field in the cwd  ← per-project isolation
 *   4. RETICLE_DEFAULT_PORT (4400)
 */

import { readFileSync } from 'node:fs';

/**
 * Read the port stored in the project's .reticle.json (written by `reticle init`).
 * Returns undefined if the file is absent, unreadable, or has no valid numeric port.
 */
export function readProjectPort(cwd: string): number | undefined {
  try {
    const raw = readFileSync(`${cwd}/.reticle.json`, 'utf8');
    const config: unknown = JSON.parse(raw);
    if (typeof config === 'object' && config !== null) {
      const p = (config as Record<string, unknown>)['port'];
      if (typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536) return p;
    }
  } catch {
    // .reticle.json absent or unreadable — fall through to default
  }
  return undefined;
}

/**
 * Read the stable projectId stored in the project's .reticle.json (written by `reticle init`). The daemon
 * uses it as the default resolve scope so auto-selection stays within the active app. Returns
 * undefined if the file is absent/unreadable or has no non-empty string projectId.
 */
export function readProjectId(cwd: string): string | undefined {
  try {
    const raw = readFileSync(`${cwd}/.reticle.json`, 'utf8');
    const config: unknown = JSON.parse(raw);
    if (typeof config === 'object' && config !== null) {
      const id = (config as Record<string, unknown>)['projectId'];
      if (typeof id === 'string' && id.length > 0) return id;
    }
  } catch {
    // .reticle.json absent or unreadable — no default scope
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
