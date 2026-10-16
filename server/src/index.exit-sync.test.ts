/**
 * `reticle drive` with no daemon and a self-booting `reticle verify` run through `start()`, which
 * never ran a sync cycle. Their runs, flows and screenshots waited on disk for a later daemon or a
 * `reticle sync` that nobody typed. `close()` now sends one bounded cycle, and only for a linked root.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { start } from './index.js';
import { PAIRING_TOKEN_DIR_ENV } from './portal/bridge/pairing-token.js';

const KEY_ENV = 'RETICLE_API_KEY';
const URL_ENV = 'RETICLE_CLOUD_URL';
const HOME_ENV = 'HOME';
const SYNC_PATH = '/v1/sync';
const saved = new Map<string, string | undefined>();
let server: Server;
let hits = 0;
let cloudUrl = '';
let port = 8700;

beforeEach(async () => {
  for (const name of [KEY_ENV, URL_ENV, HOME_ENV, PAIRING_TOKEN_DIR_ENV])
    saved.set(name, process.env[name]);
  // Never read the real machine's links or keys: the exit cycle also visits other known roots.
  const home = mkdtempSync(join(tmpdir(), 'reticle-exit-sync-home-'));
  process.env[HOME_ENV] = home;
  process.env[PAIRING_TOKEN_DIR_ENV] = join(home, 'token');
  hits = 0;
  server = createServer((req, res) => {
    // Only the sync protocol counts: start() also asks the platform for its model config.
    if (String(req.url).startsWith(SYNC_PATH)) hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  cloudUrl = `http://127.0.0.1:${String('object' === typeof address && address !== null ? address.port : 0)}`;
});

afterEach(async () => {
  for (const [name, value] of saved)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function startAndClose(): Promise<void> {
  port += 1;
  const reticleRoot = join(mkdtempSync(join(tmpdir(), 'reticle-exit-sync-')), '.reticle');
  const running = await start({ port, mcp: false, reticleRoot });
  await running.close();
}

describe('start() sends one sync cycle on close', () => {
  it('reaches the cloud when the folder is linked', async () => {
    process.env[KEY_ENV] = 'rk_test';
    process.env[URL_ENV] = cloudUrl;
    await startAndClose();
    expect(hits).toBeGreaterThan(0);
  });

  it('sends nothing when the folder is not linked', async () => {
    delete process.env[KEY_ENV];
    process.env[URL_ENV] = cloudUrl;
    await startAndClose();
    expect(hits).toBe(0);
  });
});
