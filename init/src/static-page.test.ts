/**
 * A plain HTML page: the path that already worked, reported as a failure.
 *
 * - No package.json + an index.html: `init` printed the snippet and exited 1 with `no_package_json`,
 *   on exactly the path where pasting that snippet connects. The snippet is now written into the
 *   page itself — marked so a re-run finds it, and guarded to loopback hosts because a static file
 *   has no development build to keep it out of production.
 * - A package.json with no UI library: `init` installed `@reticlehq/react` and `react` into it.
 * - A re-run over a page that already carries the snippet said "This app will NOT connect until
 *   the ⚠ step", because the step was MANUAL unconditionally and never read the file.
 */
import { describe, expect, it } from 'vitest';
import { Framework, UiLibrary } from './detect/detect.js';
import { frameworkPackages } from './plan/plan.js';
import { runInit, type InitOptions } from './run.js';
import { memoryIo, TEST_PAIRING_TOKEN } from './memory-io.test-helpers.js';
import {
  STATIC_SNIPPET_MARKER,
  STATIC_TOKEN_MODULE,
  withStaticSnippet,
} from './patch/static-page.js';

const OPTS: InitOptions = {
  cwd: '/site',
  port: undefined,
  mcp: false,
  install: false,
  dryRun: false,
};
const PAGE = `<!doctype html>
<html>
  <head><title>Hi</title></head>
  <body>
    <h1>Hello</h1>
  </body>
</html>
`;

describe('the snippet written into a static page', () => {
  const connect = `{ projectId: 'site', token: '${TEST_PAIRING_TOKEN}' }`;

  it('goes before </body>, carries the marker, and connects only on a loopback host', () => {
    const html = withStaticSnippet(PAGE, connect) ?? '';
    expect(html).toContain(STATIC_SNIPPET_MARKER);
    expect(html.indexOf(STATIC_SNIPPET_MARKER)).toBeLessThan(html.indexOf('</body>'));
    expect(html).toContain("'localhost'");
    expect(html).toContain("'127.0.0.1'");
    expect(html).toContain('location.hostname');
    // Dynamic, so a page opened anywhere else never even fetches the SDK.
    expect(html).toMatch(/import\('https:\/\//);
    expect(html).toContain('reticle.connect(');
    // Everything that was there is still there.
    for (const line of PAGE.trim().split('\n')) expect(html).toContain(line.trim());
  });

  it('is idempotent', () => {
    const once = withStaticSnippet(PAGE, connect) ?? '';
    expect(withStaticSnippet(once, connect)).toBeNull();
  });

  it('recognises a snippet somebody pasted by hand from the printed recipe', () => {
    const pasted = PAGE.replace(
      '</body>',
      '<script type="module">import { reticle } from \'https://cdn.jsdelivr.net/npm/@reticlehq/browser@3/+esm\'; reticle.connect();</script></body>',
    );
    expect(withStaticSnippet(pasted, connect)).toBeNull();
  });
});

describe('init on a page with no package.json', () => {
  it('writes the snippet into index.html and hands over to setup instead of exiting 1', () => {
    const io = memoryIo({ 'index.html': PAGE });
    const result = runInit(OPTS, io);
    expect(result.ok).toBe(true);
    expect(result.context?.appDir).toBe('/site');
    expect(io.written['index.html']).toContain(STATIC_SNIPPET_MARKER);
    expect(io.written['.reticle.json']).toBeDefined();
  });

  /**
   * The page is the deployable artifact, and the machine's pairing token was written into it as a
   * literal: commit or publish index.html and the token went with it, loopback guard or not. It now
   * lives in a module beside the page that init gitignores, which any static server serves.
   */
  it('keeps the pairing token out of index.html, in a gitignored module the page loads', () => {
    const io = memoryIo({ 'index.html': PAGE, '.gitignore': 'dist\n' });
    runInit(OPTS, io);
    const page = io.written['index.html'] ?? '';
    expect(page).not.toContain(TEST_PAIRING_TOKEN);
    expect(page).toContain(`import('./${STATIC_TOKEN_MODULE}')`);
    expect(io.written[STATIC_TOKEN_MODULE]).toContain(TEST_PAIRING_TOKEN);
    expect(io.written['.gitignore']).toBe(`dist\n${STATIC_TOKEN_MODULE}\n`);
    expect(io.lines.join('\n')).toMatch(/pairing token/i);
  });

  it('creates the .gitignore entry when there is no .gitignore', () => {
    const io = memoryIo({ 'index.html': PAGE });
    runInit(OPTS, io);
    expect(io.written['.gitignore']).toBe(`${STATIC_TOKEN_MODULE}\n`);
  });

  it('changes nothing on a second run', () => {
    const io = memoryIo({ 'index.html': PAGE });
    runInit(OPTS, io);
    const again = memoryIo({ ...io.written });
    expect(runInit(OPTS, again).ok).toBe(true);
    expect(again.written['index.html']).toBeUndefined();
  });

  it('still prints the snippet for a page it cannot see whole', () => {
    // Several pages and no index.html: which one is the app is not ours to pick.
    const io = memoryIo({ 'about.html': PAGE, 'contact.html': PAGE });
    const result = runInit(OPTS, io);
    expect(result.ok).toBe(false);
    expect(io.lines.join('\n')).toContain('reticle.connect(');
    expect(Object.keys(io.written).some((p) => p.endsWith('.html'))).toBe(false);
  });
});

describe('a package.json with no UI library', () => {
  it('installs the framework-neutral sensor, not the React adapter and react', () => {
    expect(frameworkPackages(Framework.HTML, UiLibrary.UNKNOWN)).toEqual(['@reticlehq/browser']);
  });

  it('keeps the React adapter for a React app it could not place', () => {
    expect(frameworkPackages(Framework.HTML, UiLibrary.REACT)).toEqual(['@reticlehq/react']);
  });

  const files = {
    'package.json': JSON.stringify({ name: 'plain', scripts: { dev: 'npx serve .' } }),
    'index.html': PAGE,
  };

  it('writes the same dev-only snippet and gitignored token as a page without package.json', () => {
    const io = memoryIo({ ...files, '.gitignore': 'dist\n' });
    const result = runInit(OPTS, io);
    expect(result.ok).toBe(true);
    expect(result.context?.framework).toBe(Framework.HTML);
    const page = io.written['index.html'] ?? '';
    expect(page).toContain(STATIC_SNIPPET_MARKER);
    expect(page).toContain('location.hostname');
    expect(page).toContain(`import('./${STATIC_TOKEN_MODULE}')`);
    expect(page).not.toContain(TEST_PAIRING_TOKEN);
    expect(io.written[STATIC_TOKEN_MODULE]).toContain(TEST_PAIRING_TOKEN);
    expect(io.written['.gitignore']).toBe(`dist\n${STATIC_TOKEN_MODULE}\n`);
    expect(io.lines.join('\n')).not.toContain('will NOT connect');
  });

  it('creates .gitignore and leaves all three static-page files unchanged on a second run', () => {
    const io = memoryIo(files);
    runInit(OPTS, io);
    expect(io.written['.gitignore']).toBe(`${STATIC_TOKEN_MODULE}\n`);
    const again = memoryIo({ ...files, ...io.written });
    expect(runInit(OPTS, again).ok).toBe(true);
    expect(again.written['index.html']).toBeUndefined();
    expect(again.written[STATIC_TOKEN_MODULE]).toBeUndefined();
    expect(again.written['.gitignore']).toBeUndefined();
    expect(again.lines.join('\n')).toContain('[·] Connect snippet');
  });

  it('refreshes a rotated token without rewriting the page or duplicating its ignore entry', () => {
    const io = memoryIo(files);
    runInit(OPTS, io);
    const again = memoryIo({ ...files, ...io.written });
    const rotatedToken = 'fedcba654321';
    again.host = { ...again.host, pairingToken: () => rotatedToken };
    expect(runInit(OPTS, again).ok).toBe(true);
    expect(again.written[STATIC_TOKEN_MODULE]).toContain(rotatedToken);
    expect(again.written['index.html']).toBeUndefined();
    expect(again.written['.gitignore']).toBeUndefined();
  });

  it('keeps the manual recipe when no index.html exists and writes no static token files', () => {
    const io = memoryIo({ 'package.json': files['package.json'], 'about.html': PAGE });
    expect(runInit(OPTS, io).ok).toBe(false);
    expect(io.lines.join('\n')).toContain('reticle.connect(');
    expect(io.written['index.html']).toBeUndefined();
    expect(io.written[STATIC_TOKEN_MODULE]).toBeUndefined();
    expect(io.written['.gitignore']).toBeUndefined();
  });

  it('does not write files or mint a pairing token during a dry run', () => {
    const io = memoryIo(files);
    let tokenReads = 0;
    io.host = {
      ...io.host,
      pairingToken: () => {
        tokenReads++;
        return TEST_PAIRING_TOKEN;
      },
    };
    expect(runInit({ ...OPTS, dryRun: true }, io).ok).toBe(true);
    expect(io.written).toEqual({});
    expect(tokenReads).toBe(0);
  });

  it('wires an already-served Node app when --url is supplied', () => {
    const io = memoryIo({
      ...files,
      'package.json': JSON.stringify({ name: 'plain', scripts: { dev: 'node server.mjs' } }),
    });
    const result = runInit({ ...OPTS, url: 'http://localhost:5500' }, io);
    expect(result.ok).toBe(true);
    expect(io.written['index.html']).toContain(STATIC_SNIPPET_MARKER);
    expect(io.written[STATIC_TOKEN_MODULE]).toContain(TEST_PAIRING_TOKEN);
  });

  it('preserves the earlier CSP patch when writing the connect snippet into the same page', () => {
    const policy =
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' ` +
      `https://cdn.jsdelivr.net; connect-src 'self'">`;
    const io = memoryIo({ ...files, 'index.html': PAGE.replace('</head>', `${policy}</head>`) });
    expect(runInit(OPTS, io).ok).toBe(true);
    const page = io.written['index.html'] ?? '';
    expect(page).toContain(STATIC_SNIPPET_MARKER);
    expect(page).toContain('ws://localhost:4400');
    expect(page).toContain('ws://127.0.0.1:4400');
  });

  it('does not print imports for the React adapter in a plain HTML app', () => {
    const io = memoryIo({
      'package.json': JSON.stringify({ name: 'plain', scripts: { dev: 'serve .' } }),
      'index.html': PAGE,
    });
    runInit(OPTS, io);
    const out = io.lines.join('\n');
    expect(out).not.toContain("import('@reticlehq/react')");
  });

  it('does not say the app will not connect when index.html already carries the snippet', () => {
    const files = {
      'package.json': JSON.stringify({ name: 'plain', scripts: { dev: 'serve .' } }),
      'index.html': withStaticSnippet(PAGE, "{ projectId: 'plain' }") ?? '',
    };
    const io = memoryIo(files);
    const result = runInit(OPTS, io);
    expect(io.lines.join('\n')).not.toContain('will NOT connect');
    expect(result.ok).toBe(true);
  });
});
