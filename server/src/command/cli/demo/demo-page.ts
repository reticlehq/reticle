/**
 * The page the tutorial drives when the user has no app of their own yet.
 *
 * `reticle tutorial` used to print four steps and stop. Printing is not teaching: the reader is told
 * that a verdict is the point, and then watches nothing produce one. So the tour now RUNS — against a
 * page served from here, because the alternative (drive whatever is in front of the user) is how a
 * first run ends on a login wall, and a tutorial that fails on step one teaches that Reticle does not
 * work.
 *
 * It carries the real SDK, not a stub. A demo instrumented by something other than the thing being
 * demonstrated proves nothing about the thing being demonstrated.
 *
 * WHY THERE IS NO IMPORT MAP WRITTEN DOWN HERE. The SDK is ESM with bare specifiers, the shipped
 * server has no bundler, and the obvious fix — a hand-written map of specifier to path — is the exact
 * defect this repository keeps paying for: two lists that must agree, where the one nobody updated is
 * the one that breaks. A dependency added to the SDK would leave this map short by one, the page
 * would fail to load a module, and the tour would report that the user's setup is broken.
 *
 * So the map is DISCOVERED. Start at the SDK entry, scan the files beside it for bare specifiers,
 * resolve each one, and repeat. It cannot be short by one, because nothing here knows the names.
 *
 * The walk follows imports out of OUR packages only; a third-party one is mounted whole and not
 * read. That is a deliberate line, not an oversight. Reading zod means walking several thousand
 * files to learn something that has not changed in this repository's lifetime, and it measurably
 * cost about a minute — on the one command whose whole job is a good first impression. The drift
 * this guards against is our own SDK gaining a dependency, which is the thing that actually moves;
 * a third-party leaf that grows a bare runtime import would fail loudly on the page instead, which
 * is a worse message but not a silent one.
 */

import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { dirname, join, relative, extname, sep } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

/** Where the tour starts. Everything else on the page is reached from here. */
const SDK_ENTRY = '@reticlehq/browser';

/** The signal the demo app fires when it saves — the consequence the tour declares in advance. */
export const DEMO_SIGNAL = 'demo:saved';

/** Controls the tour points at. Named here so the page and the run cannot disagree about them. */
export const DemoTestId = {
  SAVE: 'demo-save',
  NAME: 'demo-name',
  STATUS: 'demo-status',
} as const;

/** What the status line says before anything has been proved. */
const STATUS_BEFORE = 'nothing saved yet';

/** Bare specifiers this cannot serve and must not try to: the page is a browser. */
const NOT_SERVABLE = /^node:/;

/**
 * The packages whose imports are followed. See the note at the top for why the walk stops here.
 *
 * `open-verification` is listed by NAME because it is ours without being in the scope: it left the
 * org to stand on its own as the specification, and matching on `@reticlehq/` alone would silently
 * demote it to an unscanned third-party leaf. Today its only dependency is zod, which core already
 * pulls in, so nothing would have broken yet — which is exactly the kind of gap that is cheap now
 * and expensive on the day the spec grows a second dependency.
 */
const OURS = /^(@reticlehq\/|open-verification$)/;

const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * A compiled package's own imports, read off disk.
 *
 * Test files are skipped: `dist` carries compiled specs, and those import `vitest` and `node:fs`,
 * which are not part of what a page loads and would send the walk looking for packages that only
 * exist in this repository.
 */
function bareSpecifiersIn(dir: string): Set<string> {
  const found = new Set<string>();
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        if ('node_modules' !== name) walk(path);
        continue;
      }
      if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(/from\s*'([^.'][^']*)'/g)) {
        const spec = match[1];
        if (spec !== undefined && !NOT_SERVABLE.test(spec)) found.add(spec);
      }
    }
  };
  walk(dir);
  return found;
}

/** The directory holding a resolved entry's `package.json` — what has to be mounted whole. */
function packageRootOf(entryPath: string): string | undefined {
  let at = dirname(entryPath);
  for (;;) {
    if (existsSync(join(at, 'package.json'))) return at;
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

export interface SdkMount {
  /** URL prefix the page fetches under. */
  prefix: string;
  /** Directory on disk it serves from. */
  dir: string;
}

export interface SdkGraph {
  /** Bare specifier to the URL the page should load it from. */
  imports: Record<string, string>;
  mounts: SdkMount[];
  /** URL of the SDK entry module itself. */
  entry: string;
}

/**
 * Resolve the SDK and everything it reaches, as URLs a page can fetch.
 *
 * `resolve` is injected so a test can describe a dependency graph without one existing on disk —
 * and because the real one is `import.meta.resolve`, which answers against THIS module's location
 * and so cannot be pointed at a fixture.
 */
export function sdkGraph(resolve: (spec: string) => string = defaultResolve): SdkGraph {
  const imports: Record<string, string> = {};
  const mounts: SdkMount[] = [];
  const roots = new Map<string, string>();
  const queue = [SDK_ENTRY];
  const seen = new Set<string>();
  let entry = '';

  while (queue.length > 0) {
    const spec = queue.shift();
    if (spec === undefined || seen.has(spec)) continue;
    seen.add(spec);

    const entryPath = resolve(spec);
    const root = packageRootOf(entryPath);
    if (root === undefined) {
      throw new Error(`the demo page cannot serve ${spec}: it resolves outside any package`);
    }
    let prefix = roots.get(root);
    if (prefix === undefined) {
      prefix = `/sdk/${String(mounts.length)}/`;
      roots.set(root, prefix);
      mounts.push({ prefix, dir: root });
    }
    const url = prefix + relative(root, entryPath).split(sep).join('/');
    if (SDK_ENTRY === spec) entry = url;
    else imports[spec] = url;

    if (OURS.test(spec)) {
      for (const next of bareSpecifiersIn(dirname(entryPath))) queue.push(next);
    }
  }
  return { imports, mounts, entry };
}

function defaultResolve(spec: string): string {
  return fileURLToPath(import.meta.resolve(spec));
}

/**
 * The demo app, and the one line that makes it verifiable.
 *
 * Saving fires a SIGNAL as well as changing the text. Both are here on purpose: the text is what a
 * person sees, the signal is what the app itself says happened, and the tour waits on the signal
 * because that is the difference it exists to teach — a rendered word can be a coincidence, and an
 * app declaring its own state cannot.
 */
export function demoPageHtml(graph: SdkGraph, token: string, bridgeUrl: string): string {
  const importMap = JSON.stringify({ imports: graph.imports });
  const connect = JSON.stringify({ session: 'demo', url: bridgeUrl, token });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Reticle demo</title>
<script type="importmap">${importMap}</script>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2.5rem 1.5rem;max-width:34rem}
 h1{font-size:1.3rem;margin:0 0 .25rem}
 p.lede{color:#555;margin:0 0 2rem}
 label{display:block;font-weight:600;margin:0 0 .4rem}
 input{font:inherit;padding:.5rem .6rem;width:100%;box-sizing:border-box;border:1px solid #bbb;border-radius:6px}
 button{font:inherit;margin-top:1rem;padding:.55rem 1.1rem;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
 p.status{margin-top:1.5rem;padding:.75rem;background:#f4f4f5;border-radius:6px}
</style></head>
<body>
 <h1>Reticle demo</h1>
 <p class="lede">A tiny app, instrumented with the real SDK. The tutorial is about to drive it.</p>
 <label for="${DemoTestId.NAME}">Display name</label>
 <input id="${DemoTestId.NAME}" data-testid="${DemoTestId.NAME}" value="Ada">
 <button data-testid="${DemoTestId.SAVE}">Save</button>
 <p class="status" data-testid="${DemoTestId.STATUS}">${STATUS_BEFORE}</p>
<script type="module">
 import { reticle } from ${JSON.stringify(graph.entry)};
 reticle.connect(${connect});
 const status = document.querySelector('[data-testid="${DemoTestId.STATUS}"]');
 document.querySelector('[data-testid="${DemoTestId.SAVE}"]').addEventListener('click', () => {
   const name = document.querySelector('[data-testid="${DemoTestId.NAME}"]').value;
   status.textContent = 'saved ' + name;
   reticle.signal(${JSON.stringify(DEMO_SIGNAL)}, { name });
 });
</script>
</body></html>`;
}

/**
 * Serve the demo on a port the OS picks.
 *
 * Port 0 rather than a chosen number: this starts while a daemon, a dev server and possibly another
 * copy of this tour are already running, and a tutorial whose first act is a port collision has
 * taught the wrong lesson about the product.
 */
export function serveDemoPage(
  html: string,
  graph: SdkGraph,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if ('/' === path) {
      res.writeHead(200, { 'content-type': HTML_CONTENT_TYPE });
      res.end(html);
      return;
    }
    for (const mount of graph.mounts) {
      if (!path.startsWith(mount.prefix)) continue;
      const file = join(mount.dir, path.slice(mount.prefix.length));
      // A request that climbed out of the mount is not served, whatever it points at.
      if (!file.startsWith(mount.dir + sep) || !existsSync(file) || statSync(file).isDirectory()) {
        break;
      }
      res.writeHead(200, {
        'content-type': '.js' === extname(file) ? JS_CONTENT_TYPE : 'application/octet-stream',
      });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (null === address || 'string' === typeof address) {
        reject(new Error('the demo page could not be served: no port was assigned'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${String(address.port)}/`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
