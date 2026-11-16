import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ANGULAR_TOKEN_PATH, angularProxyFile } from './angular.js';

interface Written {
  status?: number;
  body?: string;
}
type Bypass = (req: unknown, res: unknown) => unknown;

const dir = mkdtempSync(join(tmpdir(), 'reticle-angular-proxy-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function loadBypass(): Promise<Bypass> {
  const file = join(dir, 'proxy.mjs');
  writeFileSync(file, angularProxyFile());
  const mod = (await import(pathToFileURL(file).href)) as {
    default: Record<string, { bypass: Bypass }>;
  };
  const entry = mod.default[ANGULAR_TOKEN_PATH];
  if (entry === undefined) {
    throw new Error('no proxy entry for the token path');
  }
  return entry.bypass;
}

function call(bypass: Bypass, url: string): { written: Written; returned: unknown } {
  const written: Written = {};
  const req = {
    url,
    headers: { 'sec-fetch-site': 'same-origin' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = {
    writeHead: (status: number) => {
      written.status = status;
    },
    end: (body: string) => {
      written.body = body;
    },
  };
  return { written, returned: bypass(req, res) };
}

/*
 * webpack-dev-server (the Angular `browser` builder) mounts a proxy entry's `bypass` for EVERY
 * request and leaves the path match to the proxy middleware. A `bypass` that answered every call
 * served the pairing token in place of the app's page, so the app never loaded.
 */
describe('the Angular proxy file', () => {
  it('leaves every other path to the dev server', async () => {
    const bypass = await loadBypass();
    for (const url of ['/', '/orders/42', '/main.js', '/__reticle/pairing-token-x']) {
      const { written, returned } = call(bypass, url);
      expect(written, url).toEqual({});
      expect(returned, url).toBeUndefined();
    }
  });

  it('answers the token path, also with a query', async () => {
    const bypass = await loadBypass();
    for (const url of [ANGULAR_TOKEN_PATH, `${ANGULAR_TOKEN_PATH}?t=1`]) {
      expect(call(bypass, url).written.status, url).toBe(200);
    }
  });
});
