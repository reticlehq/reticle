/**
 * Which directory the dev server that served a page runs in.
 *
 * The tie-breaker for a project several checkouts declare: every git worktree carries the same
 * committed `.reticle.json`, so the projectId cannot tell them apart, but the process serving the
 * page runs inside exactly one of them. Lives with the session rather than the artifact resolver
 * because both observations are about this machine's processes -- daemon state files and `lsof` --
 * which `memory/project` has no business knowing. The resolver takes the answer as an injected
 * function; the composition roots pass this one.
 */
import {
  type Checkout,
  type DevServerEntry,
  isLocalhostSubdomain,
  isLoopbackHostname,
} from '@reticlehq/core';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { captureLookup, findListenerCwd } from '@/command/cli/ports/port-holder.js';
import { reticleStateHome } from '@/command/daemon/daemon.js';
import { readDevServers } from '@/command/daemon/dev-servers.js';
import { checkoutAt, hasLinkedWorktrees } from '@/command/cli/config/checkout.js';
import { callingClientDirectory } from '@/hooks/client-directory.js';
import { originOf, type CheckoutSource, type Tab } from './session-manager.js';

/** Where `servingDirectoryOf` gets its two observations. Injected so a test needs no processes. */
export interface ServingDirectoryIo {
  /** Live dev servers that announced themselves (the Vite plugin writes `devserver-<port>.json`). */
  devServers: () => readonly DevServerEntry[];
  /** The working directory of whatever listens on `port`, or null when it cannot be read. */
  listenerCwd: (port: number) => string | null;
  /** A running dev proxy that serves names under `.localhost`, or undefined when there is none. */
  devProxy?: () => DevProxy | undefined;
}

/** A dev proxy: the ports it listens on, and the dev server port behind each name it serves. */
export interface DevProxy {
  ports: readonly number[];
  routes: readonly { hostname: string; port: number }[];
}

const DEFAULT_PORT: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

/** portless keeps its route table here: `$PORTLESS_STATE_DIR`, else `~/.portless`. */
const PORTLESS_STATE_DIR_ENV = 'PORTLESS_STATE_DIR';
const PORTLESS_STATE_DIR = '.portless';
const PORTLESS_ROUTES_FILE = 'routes.json';
const PORTLESS_PORT_FILE = 'proxy.port';

const PortlessRoutesSchema = z.array(
  z.object({ hostname: z.string(), port: z.number().int() }).passthrough(),
);

/** A file's text, or undefined when it cannot be read. */
function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Missing or unreadable: not there for this purpose.
    return undefined;
  }
}

/** The portless proxy on this machine, read from its state folder. Undefined when none runs. */
function readPortless(): DevProxy | undefined {
  const dir = process.env[PORTLESS_STATE_DIR_ENV] ?? join(homedir(), PORTLESS_STATE_DIR);
  const port = Number(readOrUndefined(join(dir, PORTLESS_PORT_FILE))?.trim());
  if (!Number.isInteger(port)) {
    return undefined;
  }
  let routes: DevProxy['routes'] = [];
  try {
    const parsed = PortlessRoutesSchema.safeParse(
      JSON.parse(readOrUndefined(join(dir, PORTLESS_ROUTES_FILE)) ?? '[]'),
    );
    if (parsed.success) {
      routes = parsed.data;
    }
  } catch {
    // A table being rewritten reads as empty: the page stays unplaced, never placed wrong.
  }
  return { ports: [port], routes };
}

const liveIo: ServingDirectoryIo = {
  devServers: () => readDevServers(reticleStateHome()),
  listenerCwd: (port) => findListenerCwd(port, captureLookup),
  devProxy: readPortless,
};

/**
 * The directory of the dev server that served `origin`, or undefined when it cannot be observed.
 *
 * Two observations, exact one first. A dev server whose plugin announced this port names its own
 * root and works on every platform. Otherwise the process listening on the port is asked for its
 * working directory, which covers frameworks with no announcing plugin (Next.js) wherever `lsof`
 * runs. Behind a dev proxy, the proxy's route table first names the dev server's own port. Loopback
 * only: a remote page's port says nothing about any process on this machine.
 */
export function servingDirectoryOf(
  origin: string,
  io: ServingDirectoryIo = liveIo,
): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (!isLoopbackHostname(url.hostname) && !isLocalhostSubdomain(url.hostname)) {
    return undefined;
  }
  // Exact first: a dev proxy serves every worktree on one port, under the name it announced.
  const byUrl = io.devServers().find((entry) => originOf(entry.url) === url.origin);
  if (byUrl !== undefined) {
    return byUrl.root;
  }
  const pagePort = '' === url.port ? DEFAULT_PORT[url.protocol] : Number(url.port);
  if (pagePort === undefined) {
    return undefined;
  }
  // Behind a dev proxy the page's port is the proxy's, and `lsof` on it names the proxy's folder.
  // The proxy's route table names the dev server's own port.
  const proxy = isLocalhostSubdomain(url.hostname) ? io.devProxy?.() : undefined;
  const route = proxy?.routes.find((r) => r.hostname === url.hostname.toLowerCase());
  if (route === undefined && true === proxy?.ports.includes(pagePort)) {
    return undefined;
  }
  const port = route?.port ?? pagePort;
  const announced = io.devServers().find((entry) => entry.port === port);
  if (announced !== undefined) {
    return announced.root;
  }
  return io.listenerCwd(port) ?? undefined;
}

/** How many ports one scan asks about. Each lookup blocks the daemon for two `lsof` runs. */
export const MAX_FOLDER_LOOKUPS = 16;

/**
 * The folder of each port in `ports`, or undefined when it cannot be read.
 *
 * `known` is the last scan's answer. A port that stays open keeps it, so a machine with many
 * listeners pays once. A port past the bound waits for the next scan. A closed port leaves the map,
 * so the next process on it is asked about.
 */
export function listenerFolders(
  ports: readonly number[],
  known: ReadonlyMap<number, string | undefined>,
  directoryOf: (port: number) => string | undefined,
): Map<number, string | undefined> {
  const folders = new Map<number, string | undefined>();
  let lookups = 0;
  for (const port of ports) {
    if (known.has(port)) {
      folders.set(port, known.get(port));
    } else if (lookups < MAX_FOLDER_LOOKUPS) {
      lookups += 1;
      folders.set(port, directoryOf(port));
    }
  }
  return folders;
}

/** The checkout whose dev server serves `origin` right now, or undefined. */
function checkoutServing(origin: string): Checkout | undefined {
  const serving = servingDirectoryOf(origin);
  return serving === undefined ? undefined : checkoutAt(serving);
}

/**
 * The live answers for a worktree-scoped resolve: the calling agent's checkout (from the directory
 * its MCP proxy runs in) and each tab's checkout (from the dev server that served it).
 *
 * A tab is placed once for each connection. A page that a different dev server serves has reloaded,
 * and a reload is a new connection. A cache by origin and time named a port that moved to another
 * worktree after the old one for its whole lifetime.
 * ponytail: a lookup that failed stays failed for that connection; the tab then counts as unknown.
 */
export function liveCheckoutSource(
  placeOrigin: (origin: string) => Checkout | undefined = checkoutServing,
): CheckoutSource {
  const placed = new WeakMap<Tab, Checkout | undefined>();
  return {
    caller: () => {
      const dir = callingClientDirectory();
      const checkout = dir === undefined ? undefined : checkoutAt(dir);
      // A repository with no linked worktree has nothing to tell apart: skip the serving lookups.
      return checkout !== undefined && hasLinkedWorktrees(checkout.commonDir)
        ? checkout
        : undefined;
    },
    ofTab: (tab) => {
      if (placed.has(tab)) {
        return placed.get(tab);
      }
      const origin = originOf(tab.url);
      const checkout = origin === undefined ? undefined : placeOrigin(origin);
      placed.set(tab, checkout);
      return checkout;
    },
  };
}
