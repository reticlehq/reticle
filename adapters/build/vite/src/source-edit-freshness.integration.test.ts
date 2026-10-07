import { renameSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { reticle } from './index.js';

/**
 * An edit on disk is what the plain module URL serves next (#881).
 *
 * Reported against a running dev server: after `src/i18n.ts` changed, `GET /src/i18n.ts` kept
 * answering with the pre-edit source while `GET /src/i18n.ts?t=…` answered with the file on disk,
 * and only a dev-server restart cleared it. A drive against that server verifies code nobody is
 * running any more, with a green verdict and no visible symptom.
 *
 * Driven against a REAL Vite dev server with the plugin installed, for both kinds of module the
 * plugin treats differently: a plain `.ts` it passes through and a `.tsx` it stamps, each saved in
 * place and by rename.
 *
 * It did not reproduce here, and the suspected cause is not in this package: `transform` holds
 * nothing between calls, and did not in the version the report came from either. What this pins is
 * that it stays that way — a transform result cached by module id fails both `.tsx` cases.
 */

interface DevServerLike {
  listen: () => Promise<unknown>;
  close: () => Promise<void>;
  httpServer?: { address(): string | { port: number } | null } | null;
}
type CreateServer = (inline: Record<string, unknown>) => Promise<DevServerLike>;

let createServer: CreateServer | undefined;

const HOOK_TIMEOUT_MS = 60_000;
const SERVER_BOOT_BUDGET_MS = 120_000;
const BEFORE = 'Start IP Passport';
const AFTER = 'Check my product';
const MAX_FETCHES = 100;
const FETCH_INTERVAL_MS = 100;

beforeAll(async () => {
  const vite = (await import('vite')) as { createServer: CreateServer };
  createServer = vite.createServer;
}, HOOK_TIMEOUT_MS);

const dirs: string[] = [];
const servers: DevServerLike[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function i18nSource(cta: string): string {
  return `export const strings = { start: ${JSON.stringify(cta)} };\n`;
}

function ctaSource(cta: string): string {
  return `export function Cta() { return <button>${cta}</button>; }\n`;
}

function appRoot(): string {
  // realpath: macOS's tmpdir is a symlink into /private, and a real project root is not one. The
  // native one also expands Windows' 8.3 tmpdir (RUNNER~1), which the JS one keeps: Vite serves the
  // long path, so a short-named root put every module outside `fs.allow` and answered 403.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'reticle-freshness-app-')));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src/sdk.js'),
    'export const reticle = { connect(){}, observeHotUpdates(){} };\nexport const install = () => {};\n',
  );
  writeFileSync(
    join(root, 'index.html'),
    '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  );
  writeFileSync(
    join(root, 'src/main.tsx'),
    "import { strings } from './i18n';\nimport { Cta } from './Cta';\nexport const app = [strings, Cta];\n",
  );
  writeFileSync(join(root, 'src/i18n.ts'), i18nSource(BEFORE));
  writeFileSync(join(root, 'src/Cta.tsx'), ctaSource(BEFORE));
  return root;
}

async function get(base: string, path: string): Promise<string> {
  const res = await fetch(`${base}${path}`);
  return res.text();
}

/**
 * Fetches until the response carries `expected`, a bounded number of times.
 *
 * The watcher reports a change before Vite has finished invalidating the module, so the first fetch
 * after a write may legitimately race it. The defect was a URL that NEVER caught up, which a bound
 * distinguishes from a slow one without asserting how long anything took.
 */
async function getOnceUpdated(base: string, path: string, expected: string): Promise<string> {
  let served = await get(base, path);
  for (let attempt = 0; attempt < MAX_FETCHES && !served.includes(expected); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL_MS));
    served = await get(base, path);
  }
  return served;
}

/** In place, the way a plain write does it. */
function writeInPlace(file: string, content: string): void {
  writeFileSync(file, content);
}

/** Temp file + rename, the way most editors and agent tools save. The watcher sees a replace. */
function writeAtomically(file: string, content: string): void {
  writeFileSync(`${file}.tmp`, content);
  renameSync(`${file}.tmp`, file);
}

async function boot(root: string): Promise<{ server: DevServerLike; base: string }> {
  const create = createServer;
  if (create === undefined) throw new Error('vite.createServer did not resolve');
  const server = await create({
    root,
    logLevel: 'silent',
    configFile: false,
    server: { port: 0, host: '127.0.0.1' },
    resolve: { alias: { '@reticlehq/react': join(root, 'src/sdk.js') } },
    plugins: [reticle()],
  });
  servers.push(server);
  await server.listen();
  const bound = server.httpServer?.address();
  const port = 'object' === typeof bound && null !== bound ? bound.port : undefined;
  if (port === undefined) throw new Error('dev server did not bind');
  return { server, base: `http://127.0.0.1:${String(port)}` };
}

describe('the plain module URL serves the file as it is on disk', () => {
  it.each([
    ['src/i18n.ts', 'in place', i18nSource, writeInPlace],
    ['src/i18n.ts', 'by rename', i18nSource, writeAtomically],
    ['src/Cta.tsx', 'in place', ctaSource, writeInPlace],
    ['src/Cta.tsx', 'by rename', ctaSource, writeAtomically],
  ])(
    '%s, saved %s',
    async (relative, _how, source, save) => {
      const root = appRoot();
      const { base } = await boot(root);
      const url = `/${relative}`;

      // Warm the module graph the way a page load does: the document, the entry, then the module.
      await get(base, '/');
      await get(base, '/src/main.tsx');
      expect(await get(base, url)).toContain(BEFORE);

      save(join(root, relative), source(AFTER));

      const served = await getOnceUpdated(base, url, AFTER);
      expect(served).toContain(AFTER);
      expect(served).not.toContain(BEFORE);
    },
    SERVER_BOOT_BUDGET_MS,
  );
});
