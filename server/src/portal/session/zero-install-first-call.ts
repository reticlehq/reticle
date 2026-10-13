/**
 * The first call that needs a page, on an app nobody wired: open that app ourselves, zero-install.
 *
 * An install through the MCP server alone (a plugin, a hand-written `npx … mcp` config) never runs
 * `init`, so the app carries no SDK and nothing ever connects. The agent's first page-needing call
 * then answered with a diagnosis, and the agent stopped there. A lease supplies the SDK to a page
 * that never dials in, so the daemon can answer that call with the app itself instead.
 *
 * Only for a call that already asked to drive or read a page, and only on evidence: exactly one dev
 * server whose process runs inside this project's folder. The port scan is machine-wide, and a
 * browser opened on another repo's app produces a confident verdict about code nobody touched. It
 * changes nothing in the repo — wiring it for good stays the agent's call, named in the notice.
 *
 * Where the serving process cannot be observed (no `lsof`, so Windows) nothing is opened and the
 * no-session answer names the lease and the init command instead.
 */
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DEV_SERVER_PORTS } from '@/command/cli/ports/resolve/cli-port.js';
import { callingClientDirectory } from '@/hooks/client-directory.js';
import { detectDevCommandInProject, initCommandIn } from './dev-server/dev-command.js';
import { probeDevServerStates } from './dev-server/dev-server-probe.js';
import { firstRunWiring, type FirstRunWiring } from './first-run-wiring.js';
import { servingDirectoryOf } from './serving-directory.js';

const LOCALHOST = 'http://localhost';

export interface FirstCallIo {
  /** The unwired web app this call is about; undefined when wired, not a web app, or no project. */
  project: () => string | undefined;
  /** Which of these ports serve HTTP right now. */
  serving: (ports: readonly number[]) => Promise<readonly number[]>;
  /** The directory the process serving `url` runs in, when it can be observed. */
  servingDirectory: (url: string) => string | undefined;
  /** Open `url` in a lease — the path that supplies the SDK when the page never dials in. */
  lease: (url: string) => Promise<unknown>;
  /** Whether a session is connected now. */
  connected: () => boolean;
}

export interface FirstCallOpened {
  url: string;
  /** One line for the agent: what was opened, what it cannot see, and how to wire it for good. */
  notice: string;
}

/** The path with symlinks resolved when it exists (lsof reports `/private/tmp`, callers `/tmp`). */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const inside = (c: string, p: string): boolean => c === p || c.startsWith(`${p}${sep}`);

/** Compared both as written and with links resolved: either spelling may be the one lsof used. */
function within(child: string | undefined, parent: string): boolean {
  if (child === undefined) return false;
  return inside(resolve(child), resolve(parent)) || inside(real(child), real(parent));
}

function openedNotice(url: string, init: string): string {
  return (
    `This app is not wired for Reticle, so Reticle opened ${url} in its own browser and supplied ` +
    'the SDK (zero-install: DOM, network, console and routes; no component state and no source ' +
    `file:line). To wire it for good, run \`${init}\`, then ` +
    'restart the dev server and reload the page.'
  );
}

/** One lease per project for the daemon's life: a failure is reported once, never retried. */
export function firstCallOpener(io: FirstCallIo): () => Promise<FirstCallOpened | undefined> {
  const tried = new Set<string>();
  return async () => {
    const dir = io.project();
    if (dir === undefined || tried.has(dir)) return undefined;
    const pinned = detectDevCommandInProject(dir)?.port;
    const candidates = new Set<number>(DEV_SERVER_PORTS);
    if (pinned !== undefined) candidates.add(pinned);
    const own = (await io.serving([...candidates]))
      .map((port) => `${LOCALHOST}:${String(port)}`)
      .filter((url) => within(io.servingDirectory(url), dir));
    const [url] = own;
    // ponytail: nothing serving yet is not an attempt, so a later call looks again.
    if (url === undefined || 1 !== own.length) return undefined;
    tried.add(dir);
    await io.lease(url).catch(() => undefined);
    if (!io.connected()) return undefined;
    return { url, notice: openedNotice(url, initCommandIn(dir)) };
  };
}

/**
 * The daemon's two answers to an app nobody wired, built together because both ask the same
 * question first — which unwired web app is this caller in. `firstRun` wires it when the agent
 * lists sessions; `openUnwiredApp` opens it zero-install on a page-needing call.
 */
export function agentWiring(
  port: number,
  sessions: { list(): readonly unknown[] },
  lease: (url: string) => Promise<unknown>,
): { firstRun: FirstRunWiring; openUnwiredApp: () => Promise<FirstCallOpened | undefined> } {
  const firstRun = firstRunWiring({ port, cliPath: process.argv[1] ?? '' });
  const openUnwiredApp = firstCallOpener({
    project: () => firstRun.projectDirectory(callingClientDirectory() ?? process.cwd()),
    serving: async (ports) => (await probeDevServerStates(ports)).serving,
    servingDirectory: (url) => servingDirectoryOf(url),
    lease,
    connected: () => 0 < sessions.list().length,
  });
  return { firstRun, openUnwiredApp };
}
