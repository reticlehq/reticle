/**
 * Something already serving half of the port the dev server is about to take (#1377).
 *
 * With a Docker or nginx stack on 5173, `init` started `pnpm dev`, and on macOS Vite can bind
 * `[::1]` beside a process holding `0.0.0.0:5173` and print no error. `localhost:5173` then served
 * the instrumented dev server and `127.0.0.1:5173` the stale container bundle, which looked like
 * "the SDK sometimes doesn't connect". Busy-port detection read the dev server's own output, and
 * Vite says nothing in that case, so the port is asked before anything is spawned. Only that
 * one-sided case is refused; a port busy on both loopbacks is one the dev server sees and moves off.
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { frameworkDevPort } from '@reticlehq/init';

/** A `port:` in a dev config: it may move the server, so the framework default is not assumed. */
const CONFIG_SETS_PORT = /\bport\s*:/;

/**
 * The port the dev server will take, when that is known: the one its script pins, else the
 * framework's default unless the dev config names a port of its own. Undefined otherwise, and
 * nothing is probed: a guessed port refusing a start would be a worse failure than this one.
 */
export function expectedDevPort(facts: {
  pinned?: number | undefined;
  framework?: string | undefined;
  devConfig?: string | undefined;
}): number | undefined {
  if (facts.pinned !== undefined) return facts.pinned;
  if (facts.framework === undefined) return undefined;
  if (facts.devConfig !== undefined && CONFIG_SETS_PORT.test(facts.devConfig)) return undefined;
  return frameworkDevPort(facts.framework);
}

/** How long one loopback address may take to answer. Local, so anything slower is nothing. */
const PROBE_TIMEOUT_MS = 400;

/** Both loopbacks: the case this exists for is a server on one and not the other. */
const LOOPBACKS = ['127.0.0.1', '::1'] as const;

function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The one loopback something answers on at `port` while the other is free, or undefined.
 *
 * Only that split is refused. A port busy on both loopbacks is one the dev server sees: Vite and
 * Next move to the next port and print it, and setup reads that, as it always has. A second Vite
 * app on 5173 is the common case, and stopping there would break a start that works. The dev server
 * cannot see a listener on only one loopback, because it binds the other with no error, and then
 * `localhost` and `127.0.0.1` serve two different apps.
 */
export async function loneLoopbackOnDevPort(port: number): Promise<string | undefined> {
  const open = await Promise.all(LOOPBACKS.map((host) => answers(port, host)));
  const answering = LOOPBACKS.filter((_, i) => true === open[i]);
  return 1 === answering.length ? answering[0] : undefined;
}

/** What setup says instead of starting a dev server on the other half of a split port. */
export function splitDevPortNote(port: number, host: string): string {
  const shown = (h: string): string => (h.includes(':') ? `[${h}]` : h);
  const other = LOOPBACKS.find((h) => h !== host) ?? host;
  return (
    `Port ${String(port)} is half taken: something answers on ${shown(host)}:${String(port)} and ` +
    `nothing on ${shown(other)}:${String(port)}. The dev server would bind ${shown(other)} with no ` +
    'error, and then localhost and 127.0.0.1 would serve two different apps, so which one a browser ' +
    'or a lease reaches would be luck. If it is this app already running, re-run with ' +
    `--url http://localhost:${String(port)} to attach to it. Otherwise stop whatever holds the ` +
    'port, or give the dev server another one.'
  );
}

/** The dev configs that can move a framework's server off its default port. */
const DEV_CONFIGS = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cjs',
  'astro.config.mjs',
  'astro.config.ts',
  'angular.json',
] as const;

/** The text of every dev config present in `appDir`, joined, or undefined when there is none. */
export function devConfigText(appDir: string): string | undefined {
  const texts = DEV_CONFIGS.flatMap((name) => {
    try {
      return [readFileSync(join(appDir, name), 'utf8')];
    } catch {
      return [];
    }
  });
  return 0 === texts.length ? undefined : texts.join('\n');
}

/** The scripts a project runs itself with, in the order init picks them. */
const DEV_SCRIPTS = ['dev', 'start', 'serve'] as const;
const PINNED_PORT = [/--port[= ]\s*(\d+)/, /(?:^|\s)-p\s*(\d+)/, /(?:^|\s)PORT=(\d+)/] as const;

/** The port the project's dev script pins (`--port`, `-p`, `PORT=`), or undefined. */
export function pinnedDevPort(appDir: string): number | undefined {
  let scripts: Record<string, unknown> = {};
  try {
    const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    scripts = manifest.scripts ?? {};
  } catch {
    return undefined;
  }
  const body = DEV_SCRIPTS.map((name) => scripts[name]).find(
    (value): value is string => 'string' === typeof value && 0 < value.trim().length,
  );
  if (body === undefined) return undefined;
  for (const pattern of PINNED_PORT) {
    const digits = pattern.exec(body)?.[1];
    if (digits !== undefined) return Number.parseInt(digits, 10);
  }
  return undefined;
}
