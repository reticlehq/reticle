import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STATIC_PAGE_INDEX,
  staticPageConnect,
  staticPageDevCommand,
  startStaticPageServer,
  type StaticPageServer,
} from './static-page-server.js';

function site(): string {
  const root = mkdtempSync(join(tmpdir(), 'reticle-static-'));
  writeFileSync(join(root, STATIC_PAGE_INDEX), '<html><body>home</body></html>');
  mkdirSync(join(root, 'js'));
  writeFileSync(join(root, 'js', 'app.js'), 'window.loaded = 1;');
  return root;
}

describe('the static page server init starts for a page with no dev script', () => {
  let running: StaticPageServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('serves index.html at / and a file below it, each with its type', async () => {
    running = await startStaticPageServer({ root: site(), port: 0 });
    const home = await fetch(`${running.url}`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).toContain('home');
    const js = await fetch(`${running.url}js/app.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
  });

  it('never serves a file outside the directory it was given', async () => {
    const root = site();
    running = await startStaticPageServer({ root: join(root, 'js'), port: 0 });
    const escaped = await fetch(`${running.url}..%2F${STATIC_PAGE_INDEX}`);
    expect(escaped.status).toBe(404);
  });

  it('answers 404 for a missing file rather than the index', async () => {
    running = await startStaticPageServer({ root: site(), port: 0 });
    expect((await fetch(`${running.url}nope.css`)).status).toBe(404);
  });

  it('announces a localhost url, the form the setup wait reads from a dev server', async () => {
    running = await startStaticPageServer({ root: site(), port: 0 });
    expect(running.url).toMatch(/^http:\/\/localhost:\d+\/$/);
  });
});

describe('when init serves the page itself', () => {
  it('only for a page with an index.html and no dev command of its own', () => {
    const root = site();
    expect(staticPageDevCommand({ appDir: root, isStaticPage: true })).toContain(
      'static-page-server.js',
    );
    expect(staticPageDevCommand({ appDir: root, isStaticPage: false })).toBeUndefined();
    const empty = mkdtempSync(join(tmpdir(), 'reticle-static-empty-'));
    expect(staticPageDevCommand({ appDir: empty, isStaticPage: true })).toBeUndefined();
  });
});

/**
 * #1544: init wrote the connect block into index.html, the file the user hands over. The server
 * now adds the block to the HTML it serves, so the file on disk stays byte-identical.
 */
describe('the connect block the static server adds to the page it serves', () => {
  const CONNECT = "{ projectId: 'site' }";
  const MARKER = 'reticle:connect';
  let running: StaticPageServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('is in the served page and not in the file on disk', async () => {
    const root = site();
    const before = readFileSync(join(root, STATIC_PAGE_INDEX));
    running = await startStaticPageServer({ root, port: 0, connect: CONNECT });
    const page = await (await fetch(running.url)).text();
    expect(page).toContain(MARKER);
    expect(page).toContain(`reticle.connect({ ...${CONNECT}, token: local.token })`);
    expect(page).toContain('home');
    expect(readFileSync(join(root, STATIC_PAGE_INDEX)).equals(before)).toBe(true);
  });

  it('is not added to a script, or twice to a page that already connects', async () => {
    const root = site();
    running = await startStaticPageServer({ root, port: 0, connect: CONNECT });
    expect(await (await fetch(`${running.url}js/app.js`)).text()).toBe('window.loaded = 1;');
    const once = await (await fetch(running.url)).text();
    writeFileSync(join(root, STATIC_PAGE_INDEX), once);
    expect(await (await fetch(running.url)).text()).toBe(once);
  });

  it('is not added when the server has no connect', async () => {
    running = await startStaticPageServer({ root: site(), port: 0 });
    expect(await (await fetch(running.url)).text()).toBe('<html><body>home</body></html>');
  });

  it('reads the project id from .reticle.json and names a bridge port that is not the default', () => {
    const root = site();
    writeFileSync(join(root, '.reticle.json'), '{ "projectId": "site-1" }');
    expect(staticPageConnect(root, 14544)).toBe(
      "{ url: 'ws://localhost:14544/reticle', projectId: 'site-1' }",
    );
  });

  it('is asked for by the command init runs, with the bridge port', () => {
    expect(
      staticPageDevCommand({ appDir: site(), isStaticPage: true, bridgePort: 14544 }),
    ).toContain('--bridge-port 14544');
  });
});
