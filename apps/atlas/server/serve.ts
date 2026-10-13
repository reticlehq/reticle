/**
 * Atlas as a public demo: the production build in `dist/` plus the same API the dev server mounts.
 *
 * Runs with plain `node server/serve.ts` on Node 23.6+ (native type stripping); Node 22 needs
 * `--experimental-strip-types`. No dependencies, no secrets.
 *
 *   PORT            listen port (default 8080)
 *   ATLAS_RESET_MS  how often visitor mutations are wiped back to the seed (default 30 minutes)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, resetState, startTimers } from './mock-api.ts';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PORT = Number(process.env['PORT'] ?? '8080');
const RESET_MS = Number(process.env['ATLAS_RESET_MS'] ?? String(30 * 60 * 1000));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

async function serveStatic(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  try {
    // normalize + prefix check: a `..` in the URL must never read outside dist/.
    const file = normalize(join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST) || file.endsWith(sep)) return null;
    return { body: await readFile(file), type: MIME[extname(file)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

const indexHtml = await readFile(join(DIST, 'index.html'));

startTimers();
setInterval(resetState, RESET_MS).unref();

createServer((req, res) => {
  void handleApi(req, res, () => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    void serveStatic(pathname).then((hit) => {
      // SPA fallback: anything that is not a file gets the app shell.
      res.writeHead(200, { 'content-type': hit?.type ?? MIME['.html'] });
      res.end(hit?.body ?? indexHtml);
    });
  });
}).listen(PORT, () => {
  process.stdout.write(
    `atlas demo on :${String(PORT)}, state resets every ${String(RESET_MS)}ms\n`,
  );
});
