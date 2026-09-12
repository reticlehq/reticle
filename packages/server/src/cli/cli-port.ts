/**
 * Port resolution for the reticle CLI. Split out so it can be unit-tested independently.
 *
 * Priority (highest → lowest):
 * 1. --port flag (parsed by parseCliArgs, already overrides defaultPort)
 * 2. RETICLE_PORT env var
 * 3..reticle.json "port" field in the cwd ← per-project isolation
 * 4. RETICLE_DEFAULT_PORT (4400)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** The project config `reticle init` writes. */
export const RETICLE_CONFIG_BASENAME = '.reticle.json';

/**
 * How far up to look for the project config before giving up.
 *
 * A cap rather than "walk to the filesystem root" so a process started somewhere unrelated cannot
 * silently adopt a config from a distant ancestor and dial a port that belongs to another project.
 * Deep enough for the layouts that actually broke: an app in `frontend/` or `apps/web/`, a git
 * worktree checked out beside its main repo, and an agent whose cwd is a package inside a monorepo.
 */
const MAX_CONFIG_SEARCH_DEPTH = 6;

/**
 * Find the nearest `.reticle.json` at or above `cwd`, and return its parsed contents.
 *
 * Every reader below used to join the basename onto `cwd` and stop there, so a process whose
 * working directory was one level away from the config behaved exactly like a project that had
 * never been through `init`: no port, no projectId, no journal setting, and a diagnostic that told
 * the user to run an install they had already run. That is the shape of several field reports at
 * once — an app wired in a subdirectory, an agent running from a repo root, a worktree beside its
 * main checkout — and they are all the same missing walk.
 *
 * Returns undefined when nothing is found, which keeps every caller's existing default intact.
 */
export function findProjectConfig(cwd: string): Record<string, unknown> | undefined {
  let dir = resolve(cwd);
  for (let depth = 0; depth <= MAX_CONFIG_SEARCH_DEPTH; depth += 1) {
    try {
      const raw = readFileSync(`${dir}/${RETICLE_CONFIG_BASENAME}`, 'utf8');
      const config: unknown = JSON.parse(raw);
      if ('object' === typeof config && config !== null && !Array.isArray(config)) {
        return config as Record<string, unknown>;
      }
    } catch {
      // Absent, unreadable, or not JSON at this level — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The dev-server port heuristics live in `@reticlehq/init` — `existing-config.ts` is what diagnoses
 * a `.reticle.json` whose `port` is the app's own dev-server port, and the scaffolder may not import
 * the daemon. Re-exported here so the runtime readers (the dev-server probe, the no-session
 * diagnosis, and `cli.ts`) are unchanged.
 */
export { DEV_SERVER_PORTS, isLikelyDevServerPort, devServerPortWarning } from '@reticlehq/init';

/**
 * Read the port stored in the project's .reticle.json (written by `reticle init`).
 * Returns undefined if the file is absent, unreadable, or has no valid numeric port.
 */
export function readProjectPort(cwd: string): number | undefined {
  const p = findProjectConfig(cwd)?.['port'];
  if ('number' === typeof p && Number.isInteger(p) && p > 0 && p < 65536) return p;
  return undefined;
}

/**
 * Read the stable projectId stored in the project's .reticle.json (written by `reticle init`). The daemon
 * uses it as the default resolve scope so auto-selection stays within the active app. Returns
 * undefined if the file is absent/unreadable or has no non-empty string projectId.
 */
export function readProjectId(cwd: string): string | undefined {
  const id = findProjectConfig(cwd)?.['projectId'];
  if ('string' === typeof id && id.length > 0) return id;
  return undefined;
}

/**
 * The framework `reticle init` stamped into `.reticle.json`, when there is one.
 *
 * Read so the no-session diagnosis can RANK its causes instead of printing one static differential.
 * Nuxt is the case that pays for this: it does not register a newly added plugin on HMR, so a dev
 * server older than the wiring is its single most likely cause — `init` warns about it at install
 * time and the hint the agent reads hours later never mentioned it.
 */
export function readProjectFramework(cwd: string): string | undefined {
  const framework = findProjectConfig(cwd)?.['framework'];
  if ('string' === typeof framework && framework.length > 0) return framework;
  return undefined;
}

/**
 * Whether the durable causal journal is enabled. On by default (the journal IS the loop); off only via
 * explicit opt-out — `.reticle.json` `"journal": false`, or `RETICLE_JOURNAL` set to `0`/`false`. The env
 * wins so CI/tests can force it off without editing the project file.
 */
export function readJournalEnabled(cwd: string, env: string | undefined): boolean {
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    if ('0' === v || 'false' === v || 'off' === v) return false;
    if ('1' === v || 'true' === v || 'on' === v) return true;
  }
  if (false === findProjectConfig(cwd)?.['journal']) return false;
  return true;
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

/**
 * Detect a port mismatch between the daemon and the project's SDK configuration.
 *
 * Returns a diagnostic string when the daemon port differs from what `.reticle.json` declares.
 * The SDK reads `.reticle.json` at build/connect time, so a mismatch means the app will dial a
 * port nothing is listening on — the silent no-connect that #261 documents.
 */
export function diagnosePortMismatch(
  daemonPort: number,
  projectPort: number | undefined,
): string | undefined {
  if (projectPort === undefined) return undefined;
  if (projectPort === daemonPort) return undefined;
  return (
    `.reticle.json says "port": ${String(projectPort)} but this daemon is on :${String(daemonPort)}` +
    ` — the SDK will dial :${String(projectPort)} and never connect. ` +
    `Either start the daemon with --port ${String(projectPort)}, or update .reticle.json to match.`
  );
}
