/**
 * The dev server `init` starts for a plain HTML page that has none of its own.
 *
 * A directory holding only `index.html` (and a script or two) used to be wired correctly — init
 * writes the connect snippet into the page — and then stop at "No dev command … start the app
 * yourself and pass --url". The one thing left between that user and a connected session was a web
 * server, which is the one thing a page like that never had. So init starts this one, the same way it
 * starts `npm run dev`, and the rest of setup (wait, open, prove the connect) runs unchanged.
 *
 * It is run as its own process (`node static-page-server.js --dir <app>`), not inside init, because it
 * has to outlive init exactly like any handed-over dev server. It imports nothing but Node, so the
 * built file runs on its own.
 *
 * Loopback only, on both families: a page served to the LAN would publish the pairing token the
 * snippet carries.
 */

import { existsSync, readFile, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STATIC_PAGE_INDEX = 'index.html';
/** Where the search for a free port starts when none is given — clear of Vite's 5173 run. */
export const STATIC_PAGE_FIRST_PORT = 5500;
const PORT_SEARCH_SPAN = 50;
const DIR_FLAG = '--dir';
const PORT_FLAG = '--port';
const LOOPBACK_V4 = '127.0.0.1';
const LOOPBACK_V6 = '::1';
const ANNOUNCED_HOST = 'localhost';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const FALLBACK_TYPE = 'application/octet-stream';

export interface StaticPageServer {
  readonly url: string;
  close(): Promise<void>;
}

/** The file a request names, or null when it is missing or outside `root`. */
function fileFor(root: string, rawUrl: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(new URL(rawUrl, 'http://x').pathname);
  } catch {
    return null;
  }
  const target = resolve(root, `.${path}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
  const file = path.endsWith('/') ? join(target, STATIC_PAGE_INDEX) : target;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      ok();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

export async function startStaticPageServer(opts: {
  root: string;
  port: number;
}): Promise<StaticPageServer> {
  const root = resolve(opts.root);
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const file = fileFor(root, req.url ?? '/');
    if (null === file) {
      res.writeHead(404).end();
      return;
    }
    readFile(file, (err, body) => {
      if (null !== err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? FALLBACK_TYPE,
        'cache-control': 'no-store',
      });
      res.end(body);
    });
  };
  const v4 = createServer(handler);
  // Port 0 means "any": the v4 bind picks it, and the v6 listener joins the same number.
  const candidates =
    0 === opts.port ? [0] : Array.from({ length: PORT_SEARCH_SPAN }, (_, i) => opts.port + i);
  let bound: number | undefined;
  for (const port of candidates) {
    try {
      await listen(v4, port, LOOPBACK_V4);
      bound = (v4.address() as AddressInfo).port;
      break;
    } catch {
      /* taken: try the next one */
    }
  }
  if (undefined === bound) {
    throw new Error(`no free port in ${String(opts.port)}–${String(opts.port + PORT_SEARCH_SPAN)}`);
  }
  // `localhost` resolves to ::1 first on macOS, so the page must answer there too. A machine with
  // no IPv6 loopback just keeps the v4 listener.
  const v6 = createServer(handler);
  const hasV6 = await listen(v6, bound, LOOPBACK_V6).then(
    () => true,
    () => false,
  );
  return {
    url: `http://${ANNOUNCED_HOST}:${String(bound)}/`,
    close: async () => {
      await closeServer(v4);
      if (hasV6) await closeServer(v6);
    },
  };
}

/**
 * The command setup runs for a page with no dev server of its own, or undefined when this is not
 * that page. Quoted so an app path with a space survives the shell.
 */
export function staticPageDevCommand(opts: {
  appDir: string;
  isStaticPage: boolean;
}): string | undefined {
  if (!opts.isStaticPage || !existsSync(join(opts.appDir, STATIC_PAGE_INDEX))) return undefined;
  const script = fileURLToPath(import.meta.url).replace(/\.ts$/, '.js');
  return `"${process.execPath}" "${script}" ${DIR_FLAG} "${opts.appDir}"`;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return -1 === at ? undefined : argv[at + 1];
}

// Run as a script: serve until killed, printing the url the setup wait reads.
if (undefined !== process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = flag(process.argv, DIR_FLAG) ?? process.cwd();
  const port = Number(flag(process.argv, PORT_FLAG) ?? STATIC_PAGE_FIRST_PORT);
  startStaticPageServer({ root: dir, port }).then(
    (server) => process.stdout.write(`serving ${dir}\n  Local: ${server.url}\n`),
    (err: unknown) => {
      process.stderr.write(`static page server: ${String(err)}\n`);
      process.exit(1);
    },
  );
}
